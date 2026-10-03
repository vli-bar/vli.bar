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
- 「壁を自動検出」→「ARでステージを開く」→壁の中心を見る。緑の候補枠が現れたらトリガーで配置し、もう一度押すと開演。以後のトリガーで停止・再生。
- 自動配置はブラウザが公開するWebXRの平面検出・ヒットテストを使用。候補がない時のトリガーは、対応環境では部屋スキャンを1回要求します。PICOのシステム側スキャン機能と、ブラウザへのデータ公開は別です。
- 自動で配置する前にサイドグリップを押すと「3点指定」へ切り替え。コントローラーの緑の点を、壁の数cm手前の左下→右下→左上に移動して各点でトリガー。舞台は下辺の幅に合わせて縦横同じ倍率で拡大します。
- 配置後のサイドグリップは停止・配置し直し。「距離を指定して配置」も選べます。「AR診断を保存」でAPIの利用状況をJSONへ保存できます。
- 詳しい操作・対応条件・診断項目は [壁へのステージ配置](docs/wall-placement.md)。部屋全体の認識、画像撮影、光学マーカー、永続アンカー、複数端末同期は未実装。
- iPhoneは対象外。PICO実機でのAPI提供・動作・性能は未確認。WebXR非対応環境でも3Dプレビュー可。

## Motion Studio

1. PICOから「PICOでモーションを収録」。VRが使える場合はVRの収録室、なければARを利用。
2. 待機中からアバターが頭・手の動きを反映します。グリップで正面を合わせ直し、トリガーで3秒後から約30Hzで記録。
3. 再度トリガーで保存してページへ戻ります。画面下の「ページへ戻る」も光線で選択でき、録画中は「保存して戻る」に変わります。最長3分・XR終了時も取得済みデータを保持。
4. 終了後は全身が見えるモーションプレビューを自動再生。一時停止・再生位置・繰り返しを操作し、VRMAをダウンロード。生の取得記録はJSONでも保存できます。
5. 他の端末から「モーションをアップロード」で取り込み。VRMA書き出しはVRM 1.0モデルに対応します。VRMA 1.0、計測JSON、旧デモJSONに対応。

アップロードは端末内の読み込みで、直近1件をIndexedDBへ保存します。JSONは32 MiBまで。ライブ表示と保存には同じ取得サンプルを使います。頭・コントローラーに加え、対応環境ではXRHandの手首と身体23関節を取得します。取得できない部位はIK等で推定し、音声・動画・指・表情は収録しません。

PICOのWeb身体追跡は、NVIDIA公式資料ではEnterprise機能・PICO Motion Trackers・対応OS/ブラウザが必要です。本アプリは任意機能として取得を試み、頭・手・身体の取得状態を表示します。PICO実機は未確認です。条件・操作: [モーション収録](docs/motion-capture.md)。交換形式: [VRMAの選定](docs/motion-formats.md)。

## 素材

- `public/demo/vli-performer.vrm`: 新規制作のオリジナルVRM。生成: `node scripts/generate-avatar.mjs`
- `public/demo/neon-door.wav`, `neon-door.vrma`: 新規作曲・振り付け。生成: `python3 scripts/generate-demo.py`（NumPyが必要）→ `node scripts/export-demo-vrma.mjs`。`motion.json` は生成元の内部データ。
- 利用条件: [VRM](public/demo/AVATAR-LICENSE.txt)、[音源・モーション](public/demo/CREDITS.txt)
- ユーザー提供VRMは `local-assets/` に保存し、Gitとビルド・配信から除外。ファイル選択による端末内読み込みは可能。

## GitHub Pages

Settings → Pages → Source を **GitHub Actions** に設定。`main` のpushでテスト・ビルド後に `dist/` を配信します。`public/CNAME` は `vli.bar`。相対アセットURLによりサブパスにも対応します。デプロイしたコミットは `/version.json` で確認できます。

今回のMVPはユーザー指定によりmainで開発。通常の開発フローは [CONTRIBUTING.md](CONTRIBUTING.md)。
