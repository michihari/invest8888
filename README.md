# 米国経済指標カレンダー（自動更新版）

毎週、GitHub Actions が Gemini API（Google検索連携）で公式の発表予定を取得し、`data/events.json` を更新します。
GitHub Pages がその内容をそのまま公開するので、ページは常に最新の日程になります。

## セットアップ（5ステップ）

1. GitHubで新しいリポジトリを作成し、このフォルダの中身をすべてアップロードします（`.github` フォルダも含めること）。
2. **Settings → Secrets and variables → Actions → New repository secret** で、名前 `GEMINI_API_KEY`、値にGeminiのAPIキーを登録します。**キーをコードやチャットに書かないでください。**
3. **Settings → Pages** で、Source を「Deploy from a branch」、Branch を `main` / `(root)` にして保存します。
4. **Actions タブ → Update economic calendar → Run workflow** で初回を手動実行します。
5. 数分後、`https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます。

以降は毎週月曜 6:00（日本時間）に自動で更新されます。

## 仕組み

- `index.html` … 画面。まず過去の公表パターンから「目安」の日付を計算し、`data/events.json` に公式確認済みの日付があれば置き換えます（「公式確認済」タグ付き）。
- `scripts/update.mjs` … Geminiに今月から3か月分の公式日程を問い合わせ、検証に通ったものだけを保存します。
- `data/indicators.json` … 指標の名称・重要度・解説。

## 安全のための検証

Geminiの回答は次の条件をすべて満たすものだけ採用します。満たさない項目は捨てられ、ページは「目安」表示のままになります。

- 対象月の平日である
- 指標ごとの通常の発表日の範囲内である
- 出典が公式ドメイン（bls.gov / bea.gov / federalreserve.gov など）のHTTPS URLである

## トラブルシューティング

- **モデルについて**: 自動で探します。`gemini-3.5-flash` → `gemini-3-flash-preview` → `gemini-3.1-flash-lite` → `gemini-2.5-flash` の順に試し、全部だめならAPIキーで使える flash 系モデルを新しい順に調べて試します。優先したいモデルがあれば、Variables に `GEMINI_MODEL` を作ります（カンマ区切りで複数可）。実際に使われたモデルは `data/events.json` の `model` に記録されます。
- **Actionsが失敗した**: ログに除外理由や取得エラーが出ます。失敗しても既存データは保持されます。
- **60日間リポジトリに動きがないと、スケジュール実行が止まる**ことがあります。止まったらActionsタブで再有効化してください。
- 政府機関の閉鎖などで通常の範囲を外れた日程は除外されます。その場合は `scripts/update.mjs` の `RANGE` を調整してください。

※ 本ページは情報提供を目的としており、投資助言ではありません。
