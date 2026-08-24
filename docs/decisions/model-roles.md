---
type: Decision
title: Роли моделей
description: Разделение решателя и извлекателя уроков, и результат проверки локальных мультимодальных возможностей macOS.
tags: [decision, models, local-inference, apple, open]
timestamp: 2026-08-13T12:00:00Z
---

**Статус: обсуждается, решение не принято.**

# Идея разделения ролей

Роли в системе естественно делятся на две:

| Роль | Требования |
|---|---|
| **Решатель** — смотрит кадр, применяет подтянутые уроки, называет координаты | Мультимодальность, скорость, дешевизна: прогонов много |
| **Извлекатель уроков** — шаг Retro и консолидация | Сильное рассуждение, вызывается редко |

Отсюда вариант: решателем поставить **слабую локальную VLM**, извлекателем — фронтир-модель.

# Аргументы за слабого решателя

- **Драматичнее кривая.** У фронтир-модели baseline в геолокации уже приличный, потолок ограничен. У маленькой локальной модели baseline плохой, и накопленный опыт даёт кратный прирост вместо процентов.
- **Бесплатные прогоны.** Можно позволить себе все [контрольные режимы](/evaluation/ablation-controls.md) и сотни задач вместо десятков.
- **Честнее по сути.** Видно, что учится именно память, а не модель — веса не меняются и заведомо слабы.

Риск — уронить baseline ниже рабочего коридора, тогда сигнала не будет вовсе. Решается [калибровкой](/evaluation/measurement-protocol.md) до начала работы над движком.

# Проверка: локальные модели Apple

Проверено 13 августа 2026 года по документации Apple.

**On-device модель Apple для этой роли не подходит.** Фреймворк Foundation Models действительно обзавёлся мультимодальным промптингом — есть типы `Attachment`, `ImageAttachmentContent`, `ImageReference`, приём `CGImage`, `CIImage`, `CVPixelBuffer` и URL. Но `SystemLanguageModel`, то есть локальная модель на устройстве, описана как «capable of text generation tasks», и изображений не принимает.

Зрение живёт у `PrivateCloudComputeLanguageModel` — серверной модели на Private Cloud Compute, в статусе beta с OS 27.0, требующей managed-entitlement `com.apple.developer.private-cloud-compute` с отдельной заявкой. То есть «мультимодальный Apple Intelligence» на практике означает поход в облако Apple.

Проверка в рантайме:

```swift
if model.capabilities.contains(.vision) { }
```

Набор возможностей: `guidedGeneration`, `reasoning`, `toolCalling`, `vision`.

**Вывод:** если нужен локальный решатель — это своя VLM через Core ML или MLX на Apple Silicon, а не Foundation Models. Для офлайн-разбора изображения без языковой модели остаётся Vision framework, но для геолокации его возможностей недостаточно.

# Citations

[1] [Foundation Models framework](https://developer.apple.com/documentation/foundationmodels)
[2] [SystemLanguageModel](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel)
[3] [PrivateCloudComputeLanguageModel](https://developer.apple.com/documentation/foundationmodels/privatecloudcomputelanguagemodel)
