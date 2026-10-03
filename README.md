# vli.bar — Live Lab

壁の向こうにオリジナルVRMのライブステージが現れるWebXRデモ。
公開先: https://vli.bar/

## 開発

```sh
npm ci
npm run dev
npm test
npm run build
```

ローカル表示: http://localhost:5173 。PICO実機でWebXRを使うにはHTTPS配信が必要です。

## ライブ

- オリジナルVRM「LUMI」、72秒・120BPMのステレオ楽曲「NEON DOOR」、30fpsのVRM Animation（.vrma）を同梱。
- 曲の再生時刻に合わせて、モーション・表情・幕を同期。歌唱・MC音声は含みません。
- PICOブラウザでAR対応を検出。「ARでステージを開く」→壁を向いてトリガーで配置・開演。次のトリガーで停止・再配置。
- 位置合わせは手動。壁面認識、マーカー認識、永続アンカー、複数端末同期は未実装。
- iPhoneは対象外。PICO実機での動作・性能は要検証。WebXR非対応環境でも3Dプレビュー可。

## Motion Studio

1. PICOから「PICOでモーションを収録」。VRが使える場合はVRの収録室、なければARを利用。
2. 正面を向き、両コントローラーを自然に構えてトリガー。3秒後から頭＋両手の姿勢を約30Hzで記録。
3. 再度トリガー、または3分で終了。XR終了時にも取得済みデータを保持。
4. 画面のモーションプレビューで確認し、VRMAをダウンロード。生の計測記録が必要な場合はJSONも保存できます。
5. 他の端末から「モーションをアップロード」で取り込み。VRMA書き出しはVRM 1.0モデルに対応します。VRMA 1.0、計測JSON、旧デモJSONに対応。

アップロードは端末内の読み込みです。サーバー保存・共有はありません。直近の1件をIndexedDBへ保存します。重要な動作はVRMA、計測記録はJSONで保存してください。記録は頭・コントローラーの姿勢データで、音声・動画・全身・表情ではありません。プレビューの腕はIK、胴体・脚は推定です。技術選定: [標準形式の選定](docs/motion-formats.md)。計測記録: [モーション形式](docs/motion-capture.md)。

## 素材

- `public/demo/vli-performer.vrm`: 新規制作のオリジナルVRM。生成: `node scripts/generate-avatar.mjs`
- `public/demo/neon-door.wav`, `neon-door.vrma`: 新規作曲・振り付け。生成: `python3 scripts/generate-demo.py`（NumPyが必要）→ `node scripts/export-demo-vrma.mjs`。`motion.json` は生成元の内部データ。
- 利用条件: [VRM](public/demo/AVATAR-LICENSE.txt)、[音源・モーション](public/demo/CREDITS.txt)
- ユーザー提供VRMは `local-assets/` に保存し、Gitとビルド・配信から除外。ファイル選択による端末内読み込みは可能。

## GitHub Pages

Settings → Pages → Source を **GitHub Actions** に設定。`main` のpushでテスト・ビルド後に `dist/` を配信します。`public/CNAME` は `vli.bar`。相対アセットURLによりサブパスにも対応します。デプロイしたコミットは `/version.json` で確認できます。

今回のMVPはユーザー指定によりmainで開発。通常の開発フローは [CONTRIBUTING.md](CONTRIBUTING.md)。
