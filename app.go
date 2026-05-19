package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

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
	combos         map[string]*comboState // key: batch_combo_id
	fallbackCombos map[string]*comboState // key: uid_giftId（BatchComboId 为空时的备用追踪）
	mu             sync.Mutex
	connected      atomic.Bool  // 当前连接状态
	lastBeat       atomic.Int64 // 最后一次心跳/事件时间戳（Unix 秒）
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		combos:         make(map[string]*comboState),
		fallbackCombos: make(map[string]*comboState),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// StartListening 启动SC监听 — 前端传入直播间号和Cookie
func (a *App) StartListening(roomIdStr string, cookie string) error {
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

	go a.connectionMonitor()
	return nil
}

// startBiliClient 开启blivedm客户端并监听SC、Guard、Gift事件
func (a *App) startBiliClient(roomId int, cookie string) error {
	c := client.NewClient(roomId)
	c.SetCookie(cookie)

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

	// 开播/下播事件也作为心跳
	c.OnLiveStart(func(start *message.LiveStart) {
		a.touchBeat()
	})
	c.OnLiveStop(func(start *message.LiveStop) {
		a.touchBeat()
	})

	// 启动 client，返回 error
	return c.Start()
}

// touchBeat 更新最后活跃时间戳
func (a *App) touchBeat() {
	a.lastBeat.Store(time.Now().Unix())
}

// connectionMonitor 监控连接状态，检测断连和重连
// 每 15 秒检查一次，如果超过 120 秒没有收到任何广播事件，认为连接已断开
// blivedm-go client 会自动重连，重连成功后会重新收到广播事件
func (a *App) connectionMonitor() {
	const checkInterval = 15 * time.Second
	const timeout = 120 * time.Second
	wasConnected := true

	for {
		time.Sleep(checkInterval)

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
