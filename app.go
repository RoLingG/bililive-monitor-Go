package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Akegarasu/blivedm-go/api"
	"github.com/Akegarasu/blivedm-go/client"
	"github.com/Akegarasu/blivedm-go/message"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// comboState 用于追踪礼物连击状态
type comboState struct {
	FallbackKey string // 备用追踪 key（uid_giftId）
	Num         int    // 当前连击数量
	LastTime    int64  // 最后一次礼物时间戳（秒）
}

// App struct
type App struct {
	ctx            context.Context
	biliClient     *client.Client
	combos         map[string]*comboState // key: batch_combo_id
	fallbackCombos map[string]*comboState // key: uid_giftId（BatchComboId 为空时的备用追踪）
	mu             sync.Mutex
	connected      atomic.Bool                       // 当前连接状态
	lastBeat       atomic.Int64                      // 最后一次心跳/事件时间戳（Unix 秒）
	cancelMonitor  context.CancelFunc                // 停止 connectionMonitor 的取消函数
	videoClient    *http.Client                      // 用于抓取B站视频页面
	videoInfoCache map[string]map[string]interface{} // 视频信息缓存，key: bvid
	videoInfoMu    sync.Mutex                        // 保护 videoInfoCache
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		combos:         make(map[string]*comboState),
		fallbackCombos: make(map[string]*comboState),
		videoClient:    &http.Client{Timeout: 15 * time.Second},
		videoInfoCache: make(map[string]map[string]interface{}),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// StartListening 启动SC监听 — 前端传入直播间号和Cookie
func (a *App) StartListening(roomIdStr string, cookie string) error {
	// 防止重复连接
	a.StopListening()
	roomId, err := strconv.Atoi(roomIdStr)
	if err != nil || roomId <= 0 {
		return fmt.Errorf("直播间号格式错误")
	}
	if cookie == "" {
		return fmt.Errorf("请输入 Cookie")
	}

	if err := a.startBiliClient(roomId, cookie); err != nil {
		runtime.EventsEmit(a.ctx, "connection-status", map[string]interface{}{
			"status":  "error",
			"message": err.Error(),
		})
		return err
	}

	// 标记已连接，启动连接监控
	a.connected.Store(true)
	a.lastBeat.Store(time.Now().Unix())
	runtime.EventsEmit(a.ctx, "connection-status", map[string]interface{}{
		"status":  "connected",
		"message": "",
	})

	// 获取初始开播状态
	if roomInfo, err := api.GetRoomInfo(roomId); err == nil {
		runtime.EventsEmit(a.ctx, "live-status", map[string]interface{}{
			"live": roomInfo.Data.LiveStatus == 1,
		})
	}

	// 推送房间号给前端
	runtime.EventsEmit(a.ctx, "room-info", map[string]interface{}{
		"roomId": roomId,
	})

	monitorCtx, monitorCancel := context.WithCancel(context.Background())
	a.cancelMonitor = monitorCancel
	go a.connectionMonitor(monitorCtx)
	return nil
}

// StopListening 断开连接，回到配置页
func (a *App) StopListening() {
	if a.biliClient != nil {
		a.biliClient.Stop()
		a.biliClient = nil
	}
	if a.cancelMonitor != nil {
		a.cancelMonitor()
		a.cancelMonitor = nil
	}
	a.connected.Store(false)
	a.mu.Lock()
	a.combos = make(map[string]*comboState)
	a.fallbackCombos = make(map[string]*comboState)
	a.mu.Unlock()

	runtime.EventsEmit(a.ctx, "connection-status", map[string]interface{}{
		"status":  "disconnected",
		"message": "",
	})
}

// startBiliClient 开启blivedm客户端并监听SC、Guard、Gift事件
func (a *App) startBiliClient(roomId int, cookie string) error {
	c := client.NewClient(roomId)
	c.SetCookie(cookie)
	a.biliClient = c

	// --- 醒目留言 (SC) ---
	c.OnSuperChat(func(superChat *message.SuperChat) {
		a.touchBeat()
		data := map[string]interface{}{
			"price":                 superChat.Price,
			"uname":                 superChat.UserInfo.Uname,
			"userId":                superChat.Uid,
			"message":               superChat.Message,
			"startTime":             superChat.StartTime,
			"endTime":               superChat.EndTime,
			"time":                  superChat.Time,
			"backgroundImage":       superChat.BackgroundImage,
			"backgroundColor":       superChat.BackgroundColor,
			"backgroundColorStart":  superChat.BackgroundColorStart,
			"backgroundColorEnd":    superChat.BackgroundColorEnd,
			"backgroundBottomColor": superChat.BackgroundBottomColor,
			"messageFontColor":      superChat.MessageFontColor,
			"face":                  superChat.UserInfo.Face,
			"guardLevel":            superChat.UserInfo.GuardLevel,
			"medalName":             superChat.MedalInfo.MedalName,
			"medalLevel":            superChat.MedalInfo.MedalLevel,
			"medalColor":            superChat.MedalInfo.MedalColor,
		}
		jsonData, _ := json.Marshal(data)
		runtime.EventsEmit(a.ctx, "superchat", string(jsonData))
	})

	// --- 上舰 (Guard) ---
	c.OnGuardBuy(func(guard *message.GuardBuy) {
		a.touchBeat()
		data := map[string]interface{}{
			"uid":        guard.Uid,
			"username":   guard.Username,
			"guardLevel": guard.GuardLevel,
			"num":        guard.Num,
			"price":      guard.Price,
			"giftName":   guard.GiftName,
			"startTime":  guard.StartTime,
			"endTime":    guard.EndTime,
		}
		jsonData, _ := json.Marshal(data)
		runtime.EventsEmit(a.ctx, "guard", string(jsonData))
	})

	// --- 礼物 (Gift) + 连击追踪 ---
	c.OnGift(func(gift *message.Gift) {
		a.touchBeat()
		// 忽略免费礼物（银瓜子等）
		if gift.CoinType == "silver" {
			return
		}

		comboId := gift.BatchComboId
		fallbackKey := fmt.Sprintf("%d_%d", gift.Uid, gift.GiftId)
		now := time.Now().Unix()

		a.mu.Lock()
		// 优先用 BatchComboId 追踪
		if comboId != "" {
			existing, hasCombo := a.combos[comboId]
			if hasCombo {
				existing.Num += gift.Num
				existing.LastTime = now
				newNum := existing.Num
				a.mu.Unlock()

				comboData := map[string]interface{}{
					"comboId": comboId,
					"num":     newNum,
				}
				jsonData, _ := json.Marshal(comboData)
				runtime.EventsEmit(a.ctx, "gift-combo-update", string(jsonData))
				return
			}
			// 新的 BatchComboId，记录并清空对应 fallback（避免重复）
			delete(a.fallbackCombos, fallbackKey)
			a.combos[comboId] = &comboState{
				FallbackKey: fallbackKey,
				Num:         gift.Num,
				LastTime:    now,
			}
			a.mu.Unlock()
		} else {
			// BatchComboId 为空，用 uid+giftId 做 fallback 追踪（5秒窗口）
			existing, hasFallback := a.fallbackCombos[fallbackKey]
			if hasFallback && (now-existing.LastTime) <= 5 {
				existing.Num += gift.Num
				existing.LastTime = now
				newNum := existing.Num
				fk := existing.FallbackKey
				a.mu.Unlock()

				comboData := map[string]interface{}{
					"comboId": fk,
					"num":     newNum,
				}
				jsonData, _ := json.Marshal(comboData)
				runtime.EventsEmit(a.ctx, "gift-combo-update", string(jsonData))
				return
			}
			// 新的 fallback combo
			a.fallbackCombos[fallbackKey] = &comboState{
				FallbackKey: fallbackKey,
				Num:         gift.Num,
				LastTime:    now,
			}
			comboId = fallbackKey // 用 fallbackKey 作为前端的 comboId
			a.mu.Unlock()
		}

		data := map[string]interface{}{
			"comboId":    comboId,
			"uid":        gift.Uid,
			"uname":      gift.Uname,
			"giftId":     gift.GiftId,
			"giftName":   gift.GiftName,
			"num":        gift.Num,
			"totalCoin":  gift.TotalCoin,
			"coinType":   gift.CoinType,
			"timestamp":  gift.Timestamp,
			"face":       gift.Face,
			"medalName":  gift.MedalInfo.MedalName,
			"medalLevel": gift.MedalInfo.MedalLevel,
			"medalColor": gift.MedalInfo.MedalColor,
			"guardLevel": gift.MedalInfo.GuardLevel,
		}
		jsonData, _ := json.Marshal(data)
		runtime.EventsEmit(a.ctx, "gift", string(jsonData))
	})

	// --- 心跳监测：注册高频广播事件作为连接存活信号 ---
	// 这些事件由 B站服务器定期推送，仅用于检测连接是否存活
	heartbeatCmds := []string{
		"ROOM_REAL_TIME_MESSAGE_UPDATE", // 房间实时消息更新
		"WATCHED_CHANGE",                // 观看人数变化，高频推送
		"ONLINE_RANK_COUNT",             // 在线排行计数
	}
	for _, cmd := range heartbeatCmds {
		c.RegisterCustomEventHandler(cmd, func(s string) {
			a.touchBeat()
		})
	}

	// 开播/下播事件也作为心跳，并推送开播状态给前端
	c.OnLiveStart(func(start *message.LiveStart) {
		a.touchBeat()
		runtime.EventsEmit(a.ctx, "live-status", map[string]interface{}{
			"live": true,
		})
	})
	c.OnLiveStop(func(start *message.LiveStop) {
		a.touchBeat()
		runtime.EventsEmit(a.ctx, "live-status", map[string]interface{}{
			"live": false,
		})
	})

	// 启动 client，返回 error
	return c.Start()
}

// touchBeat 更新最后活跃时间戳
func (a *App) touchBeat() {
	a.lastBeat.Store(time.Now().Unix())
}

// GetVideoInfo 抓取B站视频页面，从 window.__INITIAL_STATE__ 提取标题、封面、Tags
func (a *App) GetVideoInfo(bvId string) map[string]interface{} {
	// 查缓存
	a.videoInfoMu.Lock()
	if cached, ok := a.videoInfoCache[bvId]; ok {
		a.videoInfoMu.Unlock()
		return cached
	}
	a.videoInfoMu.Unlock()

	videoURL := "https://www.bilibili.com/video/" + bvId
	req, err := http.NewRequest("GET", videoURL, nil)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Referer", "https://www.bilibili.com/")

	resp, err := a.videoClient.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	html := string(body)

	result := map[string]interface{}{
		"title": "",
		"desc":  "",
		"cover": "",
		"tags":  []string{},
	}

	// 从 window.__INITIAL_STATE__ 提取所有信息
	stateJSON := ""
	if idx := strings.Index(html, "window.__INITIAL_STATE__="); idx != -1 {
		start := idx + len("window.__INITIAL_STATE__=")
		depth := 0
		end := -1
		for i := start; i < len(html); i++ {
			if html[i] == '{' {
				depth++
			} else if html[i] == '}' {
				depth--
				if depth == 0 {
					end = i + 1
					break
				}
			}
		}
		if end > start {
			stateJSON = html[start:end]
		}
	}
	if stateJSON != "" {
		var state map[string]interface{}
		if json.Unmarshal([]byte(stateJSON), &state) == nil {
			// 从 videoData 获取标题和封面（videoData 是当前视频的完整数据）
			if videoData, ok := state["videoData"].(map[string]interface{}); ok {
				if t, ok := videoData["title"].(string); ok {
					result["title"] = t
				}
				if d, ok := videoData["desc"].(string); ok {
					result["desc"] = d
				}
				if c, ok := videoData["pic"].(string); ok {
					// B站返回的封面可能是 http://，统一转为 https:// 以匹配 /cover 代理的域名校验
					result["cover"] = strings.Replace(c, "http://", "https://", 1)
				}
			}
			// 从顶层 tags 数组提取标签名（tags 是对象数组，每个元素有 tag_name 字段）
			if tagsArr, ok := state["tags"].([]interface{}); ok {
				tagNames := make([]string, 0, len(tagsArr))
				for _, item := range tagsArr {
					if tagObj, ok := item.(map[string]interface{}); ok {
						if name, ok := tagObj["tag_name"].(string); ok && name != "" {
							tagNames = append(tagNames, name)
						}
					}
				}
				result["tags"] = tagNames
			}
		}
	}

	// 写缓存
	a.videoInfoMu.Lock()
	a.videoInfoCache[bvId] = result
	a.videoInfoMu.Unlock()

	return result
}

// connectionMonitor 监控连接状态，检测断连和重连
// 每 15 秒检查一次，如果超过 120 秒没有收到任何广播事件，认为连接已断开
// blivedm-go client 会自动重连，重连成功后会重新收到广播事件
func (a *App) connectionMonitor(cancelCtx context.Context) {
	const checkInterval = 15 * time.Second
	const timeout = 120 * time.Second
	wasConnected := true

	for {
		select {
		case <-cancelCtx.Done():
			return
		case <-time.After(checkInterval):
			lastBeat := time.Unix(a.lastBeat.Load(), 0)
			elapsed := time.Since(lastBeat)

			if elapsed > timeout {
				// 连接超时，标记为断开
				if wasConnected {
					wasConnected = false
					a.connected.Store(false)

					// 清空 combo 状态（重连后连击信息已失效）
					a.mu.Lock()
					a.combos = make(map[string]*comboState)
					a.fallbackCombos = make(map[string]*comboState)
					a.mu.Unlock()

					runtime.EventsEmit(a.ctx, "connection-status", map[string]interface{}{
						"status":  "reconnecting",
						"message": "",
					})
				}
			} else {
				// 连接正常（或已恢复）
				if !wasConnected {
					wasConnected = true
					a.connected.Store(true)
					runtime.EventsEmit(a.ctx, "connection-status", map[string]interface{}{
						"status":  "connected",
						"message": "",
					})
				}
			}
		}
	}
}
