# 開発フロー

[GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow) を採用します。
`main` はいつでも利用できる状態に保ち、変更は小さな単位で Pull Request（PR）にします。

## 1. 作業ブランチを作成

```sh
git switch main
git pull --ff-only origin main
git switch -c feat/short-description
```

ブランチ名は `feat/`（機能）、`fix/`（修正）、`docs/`（文書）、`chore/`（設定・保守）を目安にします。

## 2. 変更・確認・コミット

変更内容を確認し、必要なファイルだけをステージします。

```sh
git diff --check
git diff
git add <変更したファイル>
git diff --cached --check
git commit -m "feat: 変更内容"
git push -u origin HEAD
```

秘密鍵や認証情報はコミットしません。アプリの実装後は、その変更に必要なテストとビルドも実行します。

## 3. PR を作成

GitHub で作業ブランチから `main` への PR を作成し、目的・変更点・確認結果を記入します。
作業中は Draft PR を使い、確認できたらレビュー可能な状態にします。

CI の `Repository checks` は PR 差分の空白エラーを検査します。
現時点ではアプリのテスト・ビルド・デプロイは設定されていません。
CI が成功し、指摘を解消したらマージします。共同開発時は他の開発者にレビューを依頼します。

## 4. マージ後

GitHub で **Squash and merge** を使い、作業ブランチを削除します。

```sh
git switch main
git pull --ff-only origin main
git fetch --prune
```

Squash 後のローカルブランチは、必要な変更が `main` に含まれていることを確認してから削除します。

## GitHub 側の推奨設定

以下は管理者がリポジトリの Settings で設定する項目です。このファイルだけでは適用されません。

- `main` の Ruleset で PR 経由の変更を必須にし、force push とブランチ削除を禁止する。
- CI が一度実行された後、`Repository checks` を必須チェックに指定する。
- 共同開発では承認 1 件を必須にする。単独開発では自分の PR を承認できないため必須にしない。
- Squash merging と、マージ後のブランチ自動削除を有効にする。
