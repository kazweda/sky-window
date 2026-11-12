# リリース手順

Sky Window の新しい版を公開するときの手順です。一人で開発しているので自動化はせず、ここに書いた手順を手で行います。

## バージョン番号の付け方

[セマンティック バージョニング](https://semver.org/lang/ja/)(`MAJOR.MINOR.PATCH`)に従います。試作段階なので `0.x` で運用します。

| 上げる番号 | どんなとき | 例 |
|---|---|---|
| `MINOR`(0.**1**.0 → 0.**2**.0) | 機能の追加、見た目の大きな変更 | 予報を7日間にする |
| `PATCH`(0.1.**0** → 0.1.**1**) | 不具合の修正、文言の修正 | 表示の崩れを直す |

## バージョン番号を書く場所

番号の正本は [CHANGELOG.md](../CHANGELOG.md) の最新の版です。ほかに、[index.html](../index.html) の次の5か所に同じ番号を書きます。

- `style.css?v=…`、`forecast.js?v=…`、`places.js?v=…`、`app.js?v=…`(キャッシュ対策)
- フッターの `Sky Window v…`

番号が CHANGELOG と食い違うと、テスト([test/version.test.js](../test/version.test.js))が失敗し、PR をマージできません。

### キャッシュ対策のしくみ

GitHub Pages は各ファイルを10分間キャッシュさせます。そのため、デプロイ直後は、古い `index.html` と新しい `app.js` のように、版の違うファイルが組み合わさることがあります。読み込む URL に版の番号を付けておくと、次のようになります。

- 新しい `index.html` を読んだ人は、新しい番号の URL を参照するので、新しい JS と CSS をそろって読み込む
- 古い `index.html` が残っている人は、古い番号の URL を参照するので、古い版のまま一貫して動く(10分以内に新しい版に切り替わる)

**番号を上げ忘れると、この対策は効きません。** JS や CSS を変えたら、必ず版を上げてリリースしてください。

## 日々の変更

`main` にマージすると、そのまま公開サイトにデプロイされます。そのため、変更の種類によって PR の作り方を分けます。

| 変更 | PR でやること |
|---|---|
| JS か CSS を変える | **その PR の中で版を上げる**(下の「リリースの手順」の2〜4を PR に含める)。マージした後にタグと Release を作る |
| HTML の文言だけ、README、テストなど | 版は上げない。利用者に関わる変更なら CHANGELOG の `## [Unreleased]` に書き足し、次に版を上げるときにまとめる |

CHANGELOG の書き方:

- 「追加」「変更」「修正」「削除」の小見出しに分ける
- 利用者が読んでわかる言葉で書く(コードの細部は書かない)
- README やテストだけの変更など、利用者に関わらない変更は書かない

## リリースの手順

JS や CSS を変える PR では、手順2〜4をその PR のブランチで行い、手順1と5は省きます。`[Unreleased]` にたまった変更だけを出すときは、手順1から行います。

1. **リリース用のブランチを作る**
   ```sh
   git checkout main && git pull
   git checkout -b release/v0.x.y
   ```
2. **CHANGELOG を更新する**
   - `## [Unreleased]` の下の内容を、新しい見出し `## [0.x.y] - YYYY-MM-DD` の下に移す
   - `## [Unreleased]` は空のまま残す
   - 末尾のリンクを更新する
     ```
     [Unreleased]: https://github.com/kazweda/sky-window/compare/v0.x.y...HEAD
     [0.x.y]: https://github.com/kazweda/sky-window/releases/tag/v0.x.y
     ```
3. **index.html の番号を5か所とも変える**
   ```sh
   sed -i '' 's/v=旧番号/v=0.x.y/g; s/Sky Window v旧番号/Sky Window v0.x.y/' index.html
   ```
4. **テストを実行する**
   ```sh
   node --test
   ```
5. **PR を作ってマージする**:タイトルは「v0.x.y をリリースする」にする
6. **タグを付ける**:マージしたコミットにタグを付けて push する
   ```sh
   git checkout main && git pull
   git tag v0.x.y
   git push origin v0.x.y
   ```
7. **GitHub Release を作る**:本文には CHANGELOG の該当する版の内容を写す
   ```sh
   gh release create v0.x.y --title v0.x.y --notes-file <該当する版の内容を書いたファイル>
   ```
8. **公開サイトで確かめる**:数分後に https://skywindow.netplan.jp/ を開き、フッターに新しい番号が出ていること、地図・検索・予報が動くことを確かめる
