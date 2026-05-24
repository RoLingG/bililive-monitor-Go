package main

import (
	"embed"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// Create avatar client with timeout
	avatarClient := &http.Client{Timeout: 10 * time.Second}

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "bili直播监听器",
		Width:  1024,
		Height: 768,
		AssetServer: &assetserver.Options{
			Assets: assets,
			// 中间件：拦截 /avatar 请求，代理B站CDN头像，绕过防盗链
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/avatar" {
						avatarURL := r.URL.Query().Get("url")
						// 校验URL来源，只允许B站CDN域名，防止被当作开放代理滥用
						if avatarURL == "" ||
							(!strings.HasPrefix(avatarURL, "https://i0.hdslb.com/") &&
								!strings.HasPrefix(avatarURL, "https://i1.hdslb.com/") &&
								!strings.HasPrefix(avatarURL, "https://i2.hdslb.com/")) {
							http.NotFound(w, r)
							return
						}
						req, err := http.NewRequest("GET", avatarURL, nil)
						if err != nil {
							http.NotFound(w, r)
							return
						}
						req.Header.Set("Referer", "https://www.bilibili.com/")
						req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
						resp, err := avatarClient.Do(req)
						if err != nil {
							http.NotFound(w, r)
							return
						}
						defer resp.Body.Close()
						w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
						w.Header().Set("Cache-Control", "public, max-age=3600")
						io.Copy(w, resp.Body)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
