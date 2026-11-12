# リリース手順

Sky Window の配信と、版の番号の付け方をまとめます。

## 配信のしくみ

`main` にマージすると、GitHub Actions([.github/workflows/pages.yml](../.github/workflows/pages.yml))が次の順に動き、数分で https://skywindow.netplan.jp/ に反映されます。

1. テストを実行する。失敗したら配信しない
2. 配信するファイル(`index.html`、`style.css`、`forecast.js`、`places.js`、`app.js`)をそろえる
3. `index.html` の `?v=__BUILD__` を、コミットの ID(例:`?v=f2962e5`)に置き換える
4. GitHub Pages に配信する

**版の番号を上げなくても、マージするたびに配信されます。** 版の番号は、機能がまとまったときに、下の「リリースの手順」で上げます。

### キャッシュ対策のしくみ

GitHub Pages は各ファイルを10分間キャッシュさせます。そのため、配信の直後は、古い `index.html` と新しい `app.js` のように、違う時点のファイルが組み合わさることがあります。読み込む URL にコミットの ID を付けておくと、次のようになります。

- 新しい `index.html` を読んだ人は、新しい ID の URL を参照するので、新しい JS と CSS をそろって読み込む
- 古い `index.html` が残っている人は、古い ID の URL を参照するので、古い時点のまま一貫して動く(10分以内に新しいものに切り替わる)

ID は配信のたびに自動で変わるので、手で更新する必要はありません。手元で `index.html` を開いたときは `?v=__BUILD__` のまま読み込みますが、動作に影響はありません。

`index.html` で JS や CSS を読み込むときは、必ず `?v=__BUILD__` を付けてください。付け忘れるとテスト([test/version.test.js](../test/version.test.js))が失敗します。

## 版の番号の付け方

[セマンティック バージョニング](https://semver.org/lang/ja/)(`MAJOR.MINOR.PATCH`)に従います。試作段階なので `0.x` で運用します。

| 上げる番号 | どんなとき | 例 |
|---|---|---|
| `MINOR`(0.**1**.0 → 0.**2**.0) | 機能の追加、見た目の大きな変更 | 予報を7日間にする |
| `PATCH`(0.1.**0** → 0.1.**1**) | 不具合の修正、文言の修正 | 表示の崩れを直す |

番号の正本は [CHANGELOG.md](../CHANGELOG.md) の最新の版です。ほかに書くのは、[index.html](../index.html) のフッターの `Sky Window v…` の1か所だけです。食い違うとテストが失敗します。

## 日々の変更

PR を作るときは、利用者に関わる変更を [CHANGELOG.md](../CHANGELOG.md) の `## [Unreleased]` に書き足します。

- 「追加」「変更」「修正」「削除」の小見出しに分ける
- 利用者が読んでわかる言葉で書く(コードの細部は書かない)
- README やテストだけの変更など、利用者に関わらない変更は書かない

マージした変更はすぐ公開サイトに出ますが、版の番号は次のリリースまで変わりません。

## リリースの手順

`[Unreleased]` にたまった変更がまとまったら、新しい版にします。

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
3. **フッターの番号を変える**:`index.html` の `Sky Window v旧番号` を `Sky Window v0.x.y` にする
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
8. **公開サイトで確かめる**:配信が終わったら https://skywindow.netplan.jp/ を開き、フッターに新しい番号が出ていること、地図・検索・予報が動くことを確かめる
