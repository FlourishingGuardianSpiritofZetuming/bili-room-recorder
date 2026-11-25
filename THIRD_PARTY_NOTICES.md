# 第三方组件与许可

本项目代码以 MIT 许可发布（见 `LICENSE`）。以下第三方组件随仓库或运行时使用，版权归各自作者所有。

## 随仓库分发的二进制 / 脚本

| 组件 | 版本 | 许可证 | 用途 / 来源 |
| --- | --- | --- | --- |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 随 @sherpaw/asr 0.3.0 | Apache-2.0 | 本地语音识别运行时（编译为 WebAssembly） |
| [@sherpaw/asr](https://github.com/sumimakito/sherpaw) | 0.3.0 | Apache-2.0 | sherpa-onnx 的 WASM 封装；`extension/vendor/asr-bundle.js`、`extension/vendor/prebuilt/asr.wasm` 由它打包 |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 随 WASM 构建 | MIT | ONNX 推理（包含在 asr.wasm 中） |
| [brotli-dec-wasm](https://github.com/ustclug-dev/brotli-dec-wasm) | 2.3.2 | MIT OR Apache-2.0 | 解压 B 站弹幕的 brotli 数据帧 |
| [fix-webm-duration](https://github.com/yusitnikov/fix-webm-duration) | 1.0.6 | MIT | 给录音的 WebM 补写时长元数据 |

## 运行时下载（不随仓库分发）

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| [SenseVoice 模型](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) | 以模型页面标注为准（FunAudioLLM / 阿里通义） | 本地识别用；扩展首次使用时从 HuggingFace / hf-mirror 下载到浏览器缓存，仓库不包含模型文件 |

使用、再分发或商用前，请自行核对上游最新许可证与模型使用条款。
