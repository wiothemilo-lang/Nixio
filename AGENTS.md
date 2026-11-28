# AGENTS.md — Quy chuẩn làm việc cho AI agent

> Tệp này là nguồn quy ước duy nhất cho mọi agent (Claude, Codex, Cursor, Copilot…) và người đóng góp vào Nixio. Đọc hết trước khi sửa mã. Khi quy ước thay đổi, sửa tệp này trong cùng PR. README và các tài liệu khác mô tả sản phẩm; tệp này mô tả **cách làm việc**.

## 1. Đọc gì trước khi bắt tay

| Tài liệu | Đọc khi |
|---|---|
| [`README.md`](README.md) | Cần bản đồ tính năng, lệnh chạy, định dạng `.khungthoai`, hồ sơ xuất |
| [`docs/architecture.md`](docs/architecture.md) | **Bắt buộc** trước khi chạm `native/`, `desktop/`, `src/project.js`, `src/native.js`: KTR1, quy tắc phiên bản, ranh giới tin cậy IPC, máy trạng thái tự lưu |
| [`native/README.md`](native/README.md) | Trước khi thêm/sửa operation C#; xem mục *Extending the worker* |
| [`docs/i18n.md`](docs/i18n.md) | Trước khi thêm hoặc sửa bất kỳ chuỗi giao diện nào |
| [`docs/release-reproducibility.md`](docs/release-reproducibility.md) | Trước khi chạm build, đóng gói, ký phát hành |

Khảo sát tối thiểu trước khi viết dòng đầu tiên:

1. **Đồng bộ với GitHub trước khi sửa bất cứ thứ gì.** Xem `git status` trước: nếu có thay đổi chưa commit thì commit hoặc stash có chủ đích, không pull chồng lên cây đang dở. Sau đó `git switch main && git pull --ff-only origin main`; đang ở nhánh riêng thì `git fetch origin && git rebase origin/main`. Không bắt đầu từ `main` cũ, không dùng `--force`/`reset --hard` khi pull lỗi — dừng và báo.
2. `git log --oneline -5` — biết HEAD mới nhất và những commit vừa kéo về.
3. `grep`/`glob` xem code đã có chưa; ưu tiên sửa chỗ đang có hơn tạo module mới.
4. Đọc test của vùng sắp sửa — test là đặc tả hành vi hiện tại.
5. Xác định đúng vùng: logic thuần ở `src/<module>.js`, DOM/điều phối ở `src/controllers/`, IPC/main ở `desktop/`, lõi ảnh ở `native/`, chuỗi ở `locales/`.

## 2. Bất biến kiến trúc — không được phá

1. **Vanilla ES modules, không framework.** Chỉ có hai dependency runtime là `ag-psd` và `jszip`; còn lại là devDependency build/test. Không thêm dependency khi chưa được duyệt.
2. **Renderer không bao giờ thấy đường dẫn, handle native hay khóa API.** File operation đi qua kênh `project-*`, main giữ path và map sang handle; renderer chỉ nhận `id` UUID. Không thêm kênh đọc/liệt kê/xuất credential.
3. **Mọi IPC handler mới phải bọc `trusted()` và nằm trong allowlist tường minh.** Giữ nguyên `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP, chặn điều hướng và mở cửa sổ.
4. **KTR1:** magic `KTR1`, header 12 byte, metadata 2 B–4 MiB, payload 0–512 MiB. Đổi framing phải bump dải protocol ở cả `native/NativeRpc.cs` và `src/native.js`; thêm operation **không** bump; operation lạ trả `ok:false` với `Unknown native operation`.
5. **Provider call do main dựng.** Renderer chỉ gửi `provider`, `operation`, `model`, `payload`, `endpoint` (chỉ với OpenAI-compatible) và `timeoutMs`; main tự dựng URL/header, đọc khóa từ kho và redact mọi dạng phản chiếu của khóa. Không log, không echo, không trả khóa về renderer.
6. **`.khungthoai`:** `KHUNGTHOAI\n` + uint32 độ dài manifest (≤ 16 MiB) + manifest JSON + ảnh. Chỉ tăng version khi thật cần (`v3`: bộ nhớ dịch + `templateId`; `v4`: layer stack + quyết định QA), luôn đọc được `v1`–`v4`, validate tập trung ở `src/project.js`. Stack lớp mặc định không ghi xuống.
7. **Ghi tệp atomic** (temp + rename cùng thư mục). ZIP xuất dùng ngày cố định `1980-01-01`; không thêm timestamp hay random vào artifact.
8. **Tự lưu:** mỗi page instance một slot; không dọn bản của tab khác; chỉ coi là "đã lưu" khi đọc lại được đúng `{projectId, generation, revision}`.
9. **i18n:** không hardcode chuỗi UI; khoá mới thêm đủ `locales/vi.js`, `en.js`, `ja.js`; markup dùng `data-i18n*`; `test/i18n.test.js` so khớp `index.html` với catalogue tiếng Việt.
10. **Giới hạn dữ liệu là hợp đồng:** layer tối đa 24, bộ nhớ dịch 4000, QA 2000, mẫu dự án 40 (+4 dựng sẵn). Nâng giới hạn phải sửa hằng số, test và README cùng lúc.
11. **Lỗi ra renderer là chuỗi cố định hoặc mã lỗi**, không kèm stack, path hay cause native.
12. **Không đổi hành vi xuất, redraw, tự lưu hay phục hồi mà không có test đi kèm.**

## 3. Quy ước mã

- Tệp `kebab-case.js`, named export, không default export.
- Không chấm phẩy, nháy kép, thụt 2 dấu cách, dấu phẩy cuối trong danh sách nhiều dòng.
- Comment tiếng Anh, giải thích **vì sao** hoặc bất biến, không thuật lại code.
- Hằng số giới hạn đặt tên rõ (`layerLimit`, `qaReviewEntryLimit`); object hợp đồng dùng `Object.freeze`.
- Controller nhận dependency qua một object (`setupChat({...})`), không import `src/main.js`, không giữ state ngoài `shared`.
- Chuỗi cho người dùng cuối (kể cả thông báo lỗi hiển thị) đi qua catalogue; log kỹ thuật bằng tiếng Anh.

## 4. Kiểm thử

Node 22.12+, `node:test` + `node:assert/strict`; tên test là câu mô tả hành vi; mỗi module có `test/<module>.test.js`.

| Chạm vào | Chạy |
|---|---|
| `src/*.js`, `locales/`, `index.html` | `npm test` |
| `src/controllers/**` | `npm test` + `npm run test:coverage` (sàn 25% dòng cho toàn bộ controller và cho từng tệp) |
| DOM/CSS/`index.html` | thêm `npm run test:visual` (chỉ nền tảng đã calibrate; không tự chạy `--update`) |
| `desktop/**` | `npm test` + `npm run test:desktop` (cần build) |
| `native/**` | `npm run desktop:native` rồi `REQUIRE_NATIVE=1 npm test`; máy thiếu .NET thì nêu rõ 27 test bị skip |
| prompt/tool agent | `npm run eval:agent` |
| pipeline ảnh | `npm run benchmark` |

- Không sửa test để test xanh; không thêm skip trừ khi môi trường thiếu (ví dụ thiếu `dotnet`) và phải nêu trong báo cáo.
- Trên máy không có .NET: `npm test` = 879 test, 852 pass, 27 skip, 0 fail.

## 5. Commit & PR

- Nhánh `<type>/<slug>` (`feat/`, `fix/`, `docs/`, `test/`, `chore/`), không push thẳng `main`, không force push.
- Trước khi mở PR: rebase nhánh lên `origin/main` mới nhất; nếu rebase làm đổi mã thì chạy lại test ở §4.
- Commit subject tiếng Anh, thể mệnh lệnh, ≤ 72 ký tự; body nêu **vì sao** và cách kiểm chứng.
- Không commit `node_modules/`, `dist/`, `artifacts/`, `desktop-dist/`, `release-*`, `.env*`.
- PR mô tả thay đổi, ảnh hưởng, và mục **Kiểm chứng** chép lệnh cùng số liệu thật.
- Chỉ merge khi CI 3/3 xanh (`ubuntu-latest`, `windows-latest`, `macos-15`), `mergeStateStatus: CLEAN`, không review nào yêu cầu sửa; squash + xoá nhánh.
- Không tự bump version, tạo tag hay release khi chưa được yêu cầu.

## 6. Tài liệu

- Đổi hành vi → sửa `README.md` (bảng tính năng và mục liên quan) trong cùng PR.
- Mọi con số trong README phải đếm lại từ code (`grep`, output test), không chép từ tài liệu cũ.
- Thêm operation native → `native/README.md` và checklist §7 của `docs/architecture.md`.
- Thêm ngôn ngữ → `docs/i18n.md`; đổi build/release → `docs/release-reproducibility.md`.
- Release: cập nhật `package.json`, `APP_VERSION` trong `src/updater.js`, release notes, rồi chạy `node scripts/check-release-notes.mjs`.

## 7. An toàn vận hành

- Trước khi xoá hay di chuyển: in absolute path và kiểm tra đúng đích; không `rm -rf` trên biến tính toán.
- Không sửa lịch sử đã push, không xoá tag hay nhánh của người khác.
- Không yêu cầu quyền sandbox cao hơn khi chưa bị chặn thật; không tắt CI/test để né lỗi.
- Báo cáo trung thực: nêu rõ phần chưa chạy được thay vì nói "all pass".

## 8. Lệch đã biết — đừng nhân bản

| Vị trí | Vấn đề | Hướng xử lý |
|---|---|---|
| `src/updater.js` | `APP_VERSION = "1.3.0"` trùng `package.json` | Bump cùng lúc với release notes |
| 27 test native | Bị skip khi thiếu `dotnet` | Không coi là đã kiểm chứng native |

Đã đối chiếu tài liệu Google ngày 28/11/2026: `gemini-3.1-flash-lite` và `gemini-3.5-flash-lite` đều là model stable, không còn là lệch đã biết. Nhãn "Harness v2.5" đã được sửa thành v3 ở `src/agent-context.js` và `src/controllers/chat.js`.

## 9. Definition of done

- [ ] Đã `git pull --ff-only` từ `origin/main` trước khi bắt đầu và rebase trước khi mở PR.
- [ ] `npm test` xanh; số liệu thật được ghi lại.
- [ ] Test mới/sửa nằm cạnh hành vi, không mock quá mức.
- [ ] Không có secret, path hay handle lọt ra renderer hoặc log.
- [ ] Chuỗi UI đi qua catalogue đủ ba ngôn ngữ.
- [ ] README/docs liên quan đã cập nhật; số liệu đếm lại từ code.
- [ ] `git diff --check` sạch; không có file rác hay artifact.
- [ ] PR body có mục Kiểm chứng; CI 3/3 xanh.
- [ ] Nêu rõ phần chưa kiểm được (native, Windows, macOS…).
