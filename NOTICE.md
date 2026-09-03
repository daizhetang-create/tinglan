# Open-source notices

听澜的应用代码为本项目的原创实现。运行时会使用或按需获取以下开源组件/模型：

- React — MIT License
- Vite — MIT License
- TypeScript — Apache License 2.0
- Transformers.js — Apache License 2.0
- ONNX Runtime Web（由 Transformers.js 使用）— MIT License
- `onnx-community/whisper-tiny.en` / `onnx-community/whisper-base.en`，源自 OpenAI Whisper — MIT License
- `onnx-community/opus-mt-en-zh`，源自 Helsinki-NLP OPUS-MT。发布或再分发模型时，请同时检查模型仓库当前的模型卡和许可条款；本项目保守按其 ONNX 转换仓库标注保留归属。

模型文件不随本仓库分发，而是在用户首次使用对应功能时从 Hugging Face 获取并缓存。第三方项目与模型归其各自作者所有。

