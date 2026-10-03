# PICO のモーション収録

収録画面では待機中からアバターが動きを反映します。頭部、コントローラーまたは手首をWebXRから取得し、対応ブラウザでは身体関節も使用します。取得できない胴体・脚などは推定です。音声・映像・部屋画像・表情・指の動きは記録しません。**PICO 4 Ultra実機でのAPI提供・精度・操作・ダウンロードは未確認です。**

## 操作

1. HTTPSで開き、「PICOでモーションを収録」を選びます。利用できればVR、なければARで収録室を開きます。
2. 待機中のアバターで頭と左右の手を確認します。正面を合わせ直す時は、待機中にサイドグリップを押します。
3. トリガーで3秒のカウントダウンを開始します。カウントダウン中に再度押すと開始を取り消します。
4. 収録中にトリガーを押すと保存してページへ戻ります。画面下の「ページへ戻る」をコントローラーの光線で選んでも終了でき、収録中は「保存して戻る」と表示されます。最長3分です。
5. 終了後は収録した動きを自動再生します。ポータルの枠で切り取らない全身表示で確認し、一時停止・再生位置・繰り返しを操作できます。
6. 他のツールとの交換用はVRMA、再処理用の取得記録はJSONをダウンロードします。VRMA書き出しにはVRM 1.0モデルを使用します。

直近1件はIndexedDBへ保存します。アップロードは端末内への読み込みで、サーバーへ送信・共有しません。基準空間がリセットされた場合は収録を終了し、それまでのデータを保持します。

## 取得と推定の範囲

| 入力 | 取得方法と反映 |
|---|---|
| 頭 | `getViewerPose()`。頭の向きと移動を使用。 |
| コントローラー | `getPose(gripSpace, referenceSpace)`。腕は手の位置を目標にした2ボーンIKで推定。 |
| 手首 | 任意機能`hand-tracking`。`XRInputSource.hand.get('wrist')`と`getJointPose()`で取得できればコントローラーより優先。指関節は収録しない。 |
| 身体 | 任意機能`body-tracking`。`XRFrame.body.get(jointName)`で得る空間を`getPose()`で読み、主要23関節を保存。未提供・追跡待ち・取得エラーを区別し、未取得部位は頭と手から推定。 |

身体データは関節間の位置方向から骨の向きと腰の位置を合わせます。端末の生クォータニオンをVRMへ直接コピーしません。骨軸まわりのひねりは再現しません。コントローラー・手首の回転は生データに残しますが、その回転をそのままVRMの手首へ適用する処理もありません。

身体API自体が未観測関節を推定する場合があります。「身体23関節を取得」は全関節の独立した実測を意味しません。`emulatedPosition`は位置推定のフラグであり、回転の精度や全身の実測を保証しません。[WebXR Device API](https://www.w3.org/TR/webxr/)、[Hand Input仕様](https://immersive-web.github.io/webxr-hand-input/)、[Body Tracking草案](https://immersive-web.github.io/body-tracking/)

## PICO の対応条件

NVIDIA公式のIsaac Teleop資料では、WebXRの身体追跡に**PICO 4 Ultra Enterprise、またはEnterprise機能を有効化した一般向け機体**と、PICO Motion Trackersを要求しています。一般向け機体では、トラッカーを接続・校正しただけではブラウザが`body-tracking`を許可しないと説明されています。案内される動作条件は**PICO OS 15.4.4U以降・PICO Browser 4.0.40以降**です。これはNVIDIAの当該構成の要件であり、一般向けOSのバージョン番号に読み替えるものではありません。[NVIDIA 対応機器](https://nvidia.github.io/IsaacCapture/main/overview/ecosystem.html)

同資料は最少2個の足首トラッカー、3個構成では足首2個と腰、5個構成ではさらに手首または太ももを案内しています。2個構成では上半身などに推定が入り、腰・座位・寝姿勢の精度には制約があります。端末側でペアリング・校正を済ませてください。[NVIDIA Body Tracking](https://nvidia.github.io/IsaacCapture/main/device/body_tracking.html)

PICO公式の`StartBodyTracking()`・`GetBodyTrackingData()`はUnity SDKのAPIであり、Webページから直接呼ぶAPIではありません。[PICO Unity Body Tracking](https://developer.picoxr.com/document/unity/body-tracking/)

WebXR Body Trackingは草案です。本実装はブラウザが実際に提供するデータを任意で使用し、未提供なら頭・手の取得を継続します。草案はARとVRを対象としますが、上記PICO構成のARモードを本アプリで検証した結果はありません。独自の`getBodyPose()`や未確認のネイティブ連携は使用しません。

## 生データ JSON

`format: 'vli.motion-capture'`、`version: 1`。メートル・右手系・Y上向きです。原点は**収録室の待機中に最初に追跡できた頭部位置**、正面はその時の頭の水平方向です。グリップで合わせ直すと更新されます。録画開始時に原点を変更せず、ライブ表示と保存に同じ取得サンプルを使用します。時刻だけを録画開始後の最初の有効フレームで0にします。

- `referenceSpace`・`origin`: 使用した参照空間と校正変換。
- `fps`・`duration`: 保存頻度の上限（通常30Hz）と最終フレーム時刻（最長180秒）。ライブ表示はXR描画頻度で更新。
- `initialHeadHeight`: floor空間で得た初期頭部高さ。それ以外は`null`。
- `frames`: 単調増加の`t`、`visibility`、`head`・`left`・`right`。追跡できないトラックは`null`。
- 各姿勢: `position: [x,y,z]`、`quaternion: [x,y,z,w]`、`emulatedPosition`。任意の`source`は`viewer`・`controller-grip`・`hand-wrist`。
- 任意の`body`: 草案の関節名から各姿勢へのマップ、または`null`。胴7関節、左右の肩・上腕・前腕・手首、左右の大腿・下腿・足首・足球の計23関節を対象とし、欠損は補わず、未知の関節名は取り込み時に除去。

従来の`source`・`body`のないJSONも読み込めます。非表示・フォーカスを失ったフレームには姿勢を保存せず、長い空白や欠損をまたいで補間しません。取り込み上限は**32 MiB・180秒・最大60Hz**で、数値・時刻順・単位クォータニオン・バージョンなどを検証します。

## 診断と検証

「AR診断を保存」には収録の有効機能、頭・手の取得状態と入力元、身体APIの状態・関節件数・位置推定件数も保存します。座標・回転・関節そのものは含めません。詳細は[壁配置の診断](wall-placement.md#ar診断を保存する)を参照してください。

合成フィクスチャと自動テストは、校正・欠測・手首優先・身体データの検証・VRM 0/1の軸・補間・録画上限・モデルの姿勢適用を確認します。実機の精度確認とは別です。
