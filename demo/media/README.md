# demo/media — 演示素材

这里的媒体文件来自 **samplelib.com** 的公开示例片（免费示例素材，仅用于跑通演示）：

| 文件 | 来源 |
|------|------|
| `real-video-5s.mp4` / `real-video-5s-music.mp4` | https://download.samplelib.com/mp4/sample-5s.mp4 |
| `clipB.mp4` | https://filesamples.com/samples/video/mp4/sample_640x360.mp4 |
| `real-music-15s.mp3` | https://download.samplelib.com/mp3/sample-15s.mp3 |
| `narrated.mp4` | 由 `real-video-5s.mp4` + flite 英文旁白合成（本地生成） |
| `trailer.mp4` | 由 `real-video-5s.mp4` + `clipB.mp4` 拼接，配 flite 旁白与背景音乐（本地生成） |

这些文件仅用于演示 `/README` 中展示的分析与仿制闭环，不是本项目的代码，也不属于 LICENSE 覆盖范围；
如果你要重新分发，请自行确认 samplelib / filesamples 的使用条款。

想从零复现：

```text
node demo/run-demo.mjs        # 单条感知报告（01–05）
node demo/run-demo.mjs        # 闭环演示见 README「闭环演示」一节
```
