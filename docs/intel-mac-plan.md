# План: поддержка Intel (x64) macOS в форке `vernikr/omnirush-gui`

Дата: 2026-10-17 · Апстрим: `omnirush-ai/omnirush-gui` (v3.5.2, 16 окт 2026)

> **Статус (2026-10-17): реализовано и опубликовано.** v3.6.0 этого форка собирает
> `omnirush-mac-x64-3.6.0.dmg` / `.zip` на раннере `macos-15-intel` и публикует их
> рядом с Apple Silicon-артефактами; обе архитектуры делят один `latest-mac.yml`,
> который собирает джоба `merge-mac-feed`. См. issue #2 и PR #1. Осталось только
> прогнать чек-лист приёмки (§5) на самом Intel Mac.

---

## 0. Что сделано прямо сейчас

- Форк создан: **https://github.com/vernikr/omnirush-gui** (`main`, только дефолтная ветка).
- Проверены все 79 форков апстрима: ни один не собирает Intel-сборку (ни одной ветки/тега/релиза с `omnirush-mac-x64-*`).
- ⚠️ **Безопасность:** PAT, который ты прислал в чате — классический `ghp_*` с полными правами (`repo`, `workflow`, `admin:org` и т.д.). Он уже «засвечен», поэтому **отзови его** (Settings → Developer settings → Personal access tokens → Delete) и при необходимости выпусти новый с минимальными скоупами (`repo`, `workflow`). Я использовал его только для создания форка и пуша плана.

---

## 1. Исходные факты (проверено по исходникам)

| # | Факт | Где |
|---|------|-----|
| 1 | Релиз v3.5.2 содержит только `omnirush-mac-arm64-3.5.2.dmg/.zip`; в README прямо сказано «There is no build for Intel Macs» | релиз, `README.md` |
| 2 | Матрица релиза: macOS Apple Silicon (`macos-14`, `--mac --arm64`), Windows x64, Linux x64, Linux arm64 | `.github/workflows/release-desktop.yml:98-133` |
| 3 | **Движок под Intel уже собирается**: `x86_64-apple-darwin → omnirush-engine-darwin-x64-1.18.32.tar.gz` | `apps/desktop/scripts/engine-release.json` |
| 4 | `prepare-sidecar.mjs` читает `TARGET` → на Intel-раннере скачает x64-движок; `prepare-box-helpers.mjs` соберёт `box/darwin-amd64/boxsh` | `apps/desktop/scripts/prepare-sidecar.mjs:60-73`, `prepare-box-helpers.mjs:33-44` |
| 5 | `electron-builder.base.yml` уже кладёт в mac-extraResources `opencode-x86_64-apple-darwin` и `versions.json-x86_64-apple-darwin`; `mac.target` = `dmg` + `zip` без фиксации архитектуры; `artifactName: omnirush-${os}-${arch}-${version}.${ext}` | `apps/desktop/electron-builder.base.yml` |
| 6 | Приложение **умеет** выбирать архитектуру: `selectDownloadFile()` ищет `-x64-`/`-arm64-` в списке файлов манифеста; `installerAssetArch()`/`selectReleaseAsset(..., arch)` — то же самое; `archLabel("x64") = "Intel"` | `apps/desktop/electron/main.mjs:370-395`, `apps/desktop/electron/updater.mjs:419-476` |
| 7 | `publish-electron-assets.mjs` **уже требует**, чтобы `latest-mac.yml` содержал и `mac-arm64`, и `mac-x64` артефакты, и умеет сливать одноимённые манифесты (`mergeManifests`) | `scripts/release/publish-electron-assets.mjs:160-200` |
| 8 | `electron-updater@6.3.9` `MacUpdater` сам фильтрует файлы по архитектуре: на arm64-Mac оставляет файлы с `arm64` в URL, иначе — без `arm64`, затем `findFile(files, "zip")` | `node_modules`-эквивалент: `MacUpdater.js:70-77` (проверено в исходниках пакета) |
| 9 | Имя файла фида = `${channel}${prefix}.yml`; префикс для macOS — `-mac`, **без** arch-суффикса (в отличие от Linux, где `-linux`/`-linux-arm64`) | `electron-updater` → `providers/Provider.js:20-36` |
| 10 | Electron **43.2.0** → минимальная macOS **12.0**; Electron 44+ требует macOS 13 | breaking changes Electron 44 |

**Главный вывод:** код и упаковка почти готовы к Intel. Не хватает только ноги в CI и слияния манифеста обновлений. Факты 6–9 означают, что **менять код приложения не нужно** — достаточно одного общего `latest-mac.yml` с артефактами обеих архитектур (это и есть целевая схема апстрима, см. факт 7).

---

## 2. Архитектурное решение

Схема: **один общий `latest-mac.yml` на обе архитектуры** (аналог того, как на Linux — два фида, потому что electron-updater сам добавляет arch-суффикс; на macOS он этого не делает).

```
build (macOS Apple Silicon, macos-15) ──> omnirush-mac-arm64-<v>.{dmg,zip} + latest-mac-arm64.yml
build (macOS Intel,        macos-15-intel) ─> omnirush-mac-x64-<v>.{dmg,zip}   + latest-mac-x64.yml
                                   │
                          merge-mac-feed (ubuntu-latest)
                                   ↓
                      latest-mac.yml (version + 4 файла: zip/dmg × arm64/x64)
                                   ↓
                              publish (проверка фида)
```

Почему так:
- `MacUpdater` (факт 8) по URL сам выберет нужный zip → in-place обновление (Squirrel.Mac) работает на обеих архитектурах.
- Свой путь обновления апстрима (`self-install.mjs` + `selectReleaseAsset(..., arch)`) тоже выбирает по `-x64-` → для неподписанных сборок работает.
- Отдельный фид `latest-mac-x64.yml` был бы возможен, но electron-updater соберёт имя как `${channel}-mac.yml`, т.е. придётся переопределять URL фида в коде — лишний diff и конфликты при синхронизации с апстримом.

**Альтернатива (отложить):** universal-сборка `--mac --universal` на arm64-машине. Теоретически даёт один артефакт, но требует кросс-компиляции нативных модулей (`better-sqlite3`, `node-pty`) и целевого sidecar'а под обе архитектуры — `prepare-sidecar.mjs` сейчас выбирает движок по `TARGET`/`process.arch`, т.е. пришлось бы его дорабатывать. Рискованнее, чем два раннера.

---

## 3. Шаги реализации

Каждый шаг — отдельный коммит (так проще ребейзить на апстрим).

### Шаг 1. Нога Intel в матрице релиза

`.github/workflows/release-desktop.yml`, секция `strategy.matrix.include`:

```yaml
          - name: macOS Apple Silicon
            runner: macos-15            # см. шаг 8: macos-14 retiring 2026-11-02
            platform: macos
            target: aarch64-apple-darwin
            builder_args: --mac --arm64
            update_manifest: latest-mac.yml
            feed_asset: latest-mac-arm64.yml
          - name: macOS Intel
            runner: macos-15-intel      # последний x86_64-образ Actions, до авг. 2027
            platform: macos
            target: x86_64-apple-darwin
            builder_args: --mac --x64
            update_manifest: latest-mac.yml
            feed_asset: latest-mac-x64.yml
```

Остальным ногам добавить `feed_asset: ${{ matrix.update_manifest }}` (или не задавать — см. шаг 3, там есть фолбэк).
`timeout-minutes` для macOS уже 300 (нотаризация) — трогать не надо.
`-c.mac.forceCodeSigning=true` убрать, пока нет Developer ID (см. шаг 2).

### Шаг 2. Условная подпись macOS (иначе сборка упадёт без секретов)

Сейчас `scripts/release/macos-signing-env.sh` **жёстко падает**, если `MAC_CSC_LINK` не задан. Нужно сделать шаги `Prepare macOS signing`, `Notarize macOS disk image`, `Verify macOS signature and notarization` условными:

```yaml
    env:
      MAC_SIGNING: ${{ secrets.MAC_CSC_LINK != '' }}
...
      - name: Prepare macOS signing
        if: matrix.platform == 'macos' && env.MAC_SIGNING == 'true'
...
      - name: Notarize macOS disk image
        if: matrix.platform == 'macos' && env.MAC_SIGNING == 'true'
...
      - name: Verify macOS signature and notarization
        if: matrix.platform == 'macos' && env.MAC_SIGNING == 'true'
```

Плюс проверить, что `apps/desktop/scripts/electron-after-sign.cjs` корректно работает в ad-hoc режиме (без сертификата) — первый же прогон покажет.

### Шаг 3. Уникальное имя манифеста при загрузке

В шаге `Verify and upload installers and update manifest` (сейчас обе mac-ноги залили бы `latest-mac.yml` и перетёрли друг друга через `--clobber`):

```bash
          manifest="apps/desktop/dist-electron/$UPDATE_MANIFEST"      # latest-mac.yml — для проверок
          node apps/desktop/scripts/verify-update-manifest.mjs --manifest "$manifest" --version "$RELEASE_VERSION"
          feed_asset="${FEED_ASSET:-$UPDATE_MANIFEST}"                # latest-mac-arm64.yml / latest-mac-x64.yml
          if [ "$feed_asset" != "$UPDATE_MANIFEST" ]; then
            cp "$manifest" "apps/desktop/dist-electron/$feed_asset"
            manifest="apps/desktop/dist-electron/$feed_asset"
          fi
          assets+=("$manifest")
```
и в `env:` шага добавить `FEED_ASSET: ${{ matrix.feed_asset }}`.
Проверка `verify-update-manifest.mjs` остаётся на «родном» `latest-mac.yml`: `requiredInstallerExtensions()` требует `.zip` + `.dmg` — для x64-ноги это выполняется.

### Шаг 4. Новый скрипт слияния манифестов

`scripts/release/merge-mac-update-manifests.mjs` + `merge-mac-update-manifests.test.mjs` (в репо у каждого release-скрипта есть тест-двойник — держим стиль):

```
node scripts/release/merge-mac-update-manifests.mjs \
  --release v3.5.2 --repo $GITHUB_REPOSITORY \
  --inputs latest-mac-arm64.yml,latest-mac-x64.yml \
  --output latest-mac.yml [--keep-inputs]
```

Логика:
1. `gh release download` обоих входных манифестов.
2. Проверки: `version` совпадает у обоих; в сумме файлов есть `mac-arm64` **и** `mac-x64`; у каждого файла есть `url`, `sha512`, `size`; нет дублей `url` и «чужих» дистрибутивов (префикс `omnirush-`).
3. Итог — как у апстрима (`mergeManifests`): `{ version, files, releaseDate }`, при этом `files` отсортированы стабильно (arm64 раньше x64, внутри — zip перед dmg). Поля `path`/`sha512` намеренно **не** пишем: `electron-updater` 6.3.9 использует `files` (`Provider.resolveFiles → getFileList`), а свой парсер (`main.mjs`) тоже читает `files`. Если оставить `path` от arm64 — старые клиенты на Intel рискуют скачать arm64.
4. `gh release upload … --clobber` итогового `latest-mac.yml`; по умолчанию удалить входные `latest-mac-*.yml` (`gh release delete-asset`).

### Шаг 5. Job `merge-mac-feed` и зависимость publish

```yaml
  merge-mac-feed:
    name: Merge macOS update feed
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ needs.prepare.outputs.tag }}, fetch-depth: 1, sparse-checkout: scripts/release }
      - name: Merge latest-mac.yml
        env: { GH_TOKEN: ${{ github.token }}, RELEASE_TAG: ${{ needs.prepare.outputs.tag }} }
        run: |
          node scripts/release/merge-mac-update-manifests.mjs \
            --release "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" \
            --inputs latest-mac-arm64.yml,latest-mac-x64.yml --output latest-mac.yml

  publish:
    needs: [prepare, build, merge-mac-feed]
```

Цикл проверки фида в `publish` (`for manifest in latest.yml latest-mac.yml latest-linux.yml latest-linux-arm64.yml`) **менять не нужно**: теперь `latest-mac.yml` обязан содержать обе архитектуры, и проверка «каждый файл из манифеста — ассет этого релиза» автоматически покроет x64.
`SHA256SUMS.txt` соберётся сам: publish качает `omnirush-*`, куда попадают и `omnirush-mac-x64-*`.

### Шаг 6. Координаты фида обновлений → твой репозиторий

Иначе установленное приложение продолжит искать обновления в релизах апстрима (там x64 нет → Intel-сборка никогда не обновится).

Заменить `omnirush-ai/omnirush-gui` → `vernikr/omnirush-gui`:
- `apps/desktop/electron/main.mjs:184-186` (`RELEASE_DOWNLOAD_BASE_URL`, `RELEASE_PAGE_URL`, `DOCS_PAGE_URL`)
- `apps/desktop/electron/updater.mjs:69, 242, 433, 979` (`STABLE_UPDATER_FEED_URL`, targeted feed, recovery manifest)
- `apps/desktop/electron/recovery.mjs:106, 127, 130` (префикс URL релиза и его проверка)
- `apps/desktop/electron-builder.yml` → `publish.owner/repo`

**Не трогать:** `apps/desktop/scripts/engine-release.json` — тарболлы движка лежат в pre-release апстрима и запинены по sha256; если переключить, `prepare-sidecar` их не найдёт.
Тесты `updater.test.mjs`/`recovery` держат захардкоженные URL — их тоже обновить.

### Шаг 7. Документация

- `README.md`: добавить строку `| macOS, Intel | omnirush-mac-x64-<version>.dmg (+ .zip) |` и убрать фразу «There is no build for Intel Macs».
- `docs/updates.md`: в таблицах фидов/ассетов добавить macOS Intel и абзац про то, что `latest-mac.yml` — общий для двух архитектур и собирается job'ой слияния.
- `RELEASING.md`: описать ногу macOS Intel, `merge-mac-feed` и что Intel-сборка пока неподписанная.

### Шаг 8. Опционально / вторая очередь

1. **Перенести arm64-ногу с `macos-14`** → `macos-15` (или `macos-26`): образ `macos-14` retiring **2026-11-02**, brownouts уже идут. Отдельным коммитом и с проверкой, что `LSMinimumSystemVersion` остался `12.0`.
2. `scripts/release/check-macos-installer.sh:98-99` — захардкожены репозиторий и `omnirush-mac-arm64-$latest.zip`; параметризовать `--repo/--arch`.
3. `.github/workflows/build-electron-desktop.yml` — добавить smoke-пакетирование x64 на `macos-15-intel`; строка 338 проверяет `sidecars/opencode-aarch64-apple-darwin` → сделать путь зависимым от архитектуры.

---

## 4. Быстрый путь: собрать локально прямо сейчас (до CI)

На Intel Mac (Node 24, pnpm 11.4.0, bun 1.3.10, Go — как в workflow):

```bash
git clone https://github.com/vernikr/omnirush-gui && cd omnirush-gui
pnpm install --frozen-lockfile
cd apps/desktop
TARGET=x86_64-apple-darwin pnpm run build:electron
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder \
  --config electron-builder.yml --mac --x64 --publish never \
  -c.extraMetadata.version=3.5.2
# → apps/desktop/dist-electron/omnirush-mac-x64-3.5.2.dmg (и .zip)
```

Первый запуск (сборка ad-hoc, без нотаризации):
```bash
xattr -dr com.apple.quarantine /Applications/omnirush.app
```

---

## 5. Чек-лист приёмки Intel-сборки

- [ ] `file /Applications/omnirush.app/Contents/Resources/sidecars/opencode-x86_64-apple-darwin` → `Mach-O 64-bit executable x86_64`
- [ ] `ls /Applications/omnirush.app/Contents/Resources/sidecars/box/` → `darwin-amd64/boxsh`
- [ ] `uname -m` → `x86_64`; в приложении (диагностика/About) архитектура = `x64 / Intel`, а не Rosetta
- [ ] Агент запускается: модель отвечает, терминал/файлы/инструменты работают
- [ ] Linux-sandbox поднимается (образ `linux/amd64`)
- [ ] Обновление vN → vN+1 скачивает `omnirush-mac-x64-*.zip`, а не arm64
- [ ] `latest-mac.yml` релиза: `version` = версии релиза, 4 файла (`zip`+`dmg` × `arm64`+`x64`)
- [ ] `SHA256SUMS.txt` содержит x64-ассеты

---

## 6. Риски и развилки

| Риск | Что делать |
|------|-----------|
| `macos-15-intel` — последний x86_64-образ Actions, EOL **август 2027** (есть и `macos-26-intel`) | После 2027: self-hosted Intel-раннер или universal-сборка. Заложить в комментарий к workflow |
| Apple Silicon-нога на `macos-14` retiring **2026-11-02** | Перенести на `macos-15`/`macos-26` (шаг 8.1) |
| Electron 43 → macOS 12.0 minimum. Electron 44+ отсекает Monterey | Если твой Mac на macOS 12 — держать Electron `43.x`, не принимать мажорные апдейты зависимостей |
| Нет Apple Developer ID → сборка ad-hoc | Gatekeeper предупреждение + путь обновления через `self-install.mjs` (DMG), как описано в `docs/updates.md`. Опционально: подписать своим сертификатом |
| В форке CI (`ci-tests.yml`) uses раннеры `blacksmith-16vcpu-ubuntu-2204` — их у тебя нет | На релиз не влияет (`release-desktop.yml` на стандартных раннерах). Для PR-проверок отключить лишние workflow или перевести на `ubuntu-22.04` |
| Апстрим коммитит ~ежедневно (572 коммита за месяц) | Держать изменения минимальными и в новых/изолированных файлах; регулярно делать sync fork + rebase ветки `intel-mac` |

---

## 7. Что делать дальше — твой выбор

1. **Реализовать шаги 1–7** в ветке `intel-mac` и открыть PR в твоём форке (готов сделать сразу).
2. **Сначала показать диффы** без пуша — ты смотришь и утверждаешь.
3. Уточнить про **подпись**: собираем неподписанные сборки (быстро, но Gatekeeper + self-install) или у тебя есть Apple Developer ID для подписи/нотаризации?
4. Уточнить **какую macOS** стоит на твоём Intel Mac (определяет, можно ли переходить на Electron 44+).
