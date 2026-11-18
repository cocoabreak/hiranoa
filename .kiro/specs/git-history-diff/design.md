# 設計: Git履歴とMarkdownのビジュアル差分

ステータス: 実装・検証完了

## アーキテクチャ

`git2`をdefault-featuresなしで追加し、ローカルのcommit/tree/blobだけを読む。Git実行ファイルは不要。リモート、checkout、index更新、config由来の外部処理を使わない。通常のSourceBackendは変更せず、履歴専用の短命なセッションをRustに保持する。

認可済みNative文書から親をたどり.gitの存在のみを調べる。メタデータ本文の読込前に、文書・リポジトリのパスを示すネイティブ確認を行う。FSのAllowedRootsへルートを登録しない。このメタデータ存在探索はstat_path同様に内容を返さない限定操作であり、以後の読込は履歴セッションの許可範囲に固定する。

初版は通常の.gitディレクトリだけを扱い、外部gitdir、commondir、alternates、object保存先のルート外参照を拒否する。検証済みobjectsだけをOdbに登録しRepository::from_odbで包み、空configを設定する。Repositoryの通常openを使わず、local/global config、include、grafts、shallowの自動読込を避ける。HEADとrefsは各4096 bytes・参照8段、packed-refsは2MiBの有界読込でSHA-1 Oidを解決する。履歴は生のcommit parentを使い、grafts/shallowによる履歴の書換えは適用しない。毎回文書・root/.gitのcanonicalな同一性を確認する。入力revisionは返した完全commit IDかworkingだけを許可し、任意のrev式・tree pathをWebViewに指定させない。

本文は各2MiB、履歴100件・走査5000commit・10秒、セッション1件、blob画像各5MiB・セッション合計32MiB・100件。object headerを先に確認し、symlink/gitlinkモードを拒否する。画像は相対参照を文書のGitパスから正規化し、repo root外・絶対パス・URL・NULを拒否する。working本文は既存の安全なファイル読込を使用する。working画像もAllowedRootsを通す。

## 差分と描画

Markdownのトップレベルブロックを対応付ける。原文の完全一致をアンカーにした有界LCSと、アンカー間の変更ブロックの対応付けで追加・削除・変更を得る。最大800ブロック、行単位ソース差分は最大4000行、計算上限を超える場合はエラーとする。本文変更の語句はテキストnodeだけへmarkを挿入し、HTML文字列を差分用に連結しない。図・コード・数式などはブロック全体を比較する。

既存のMarkdownエンジン、サニタイズ、ID名前空間、Mermaid後処理を再利用する。比較処理とUIは遅延ロードし、初期ロードへ新規依存を入れない。通常文書のCSS／設定は維持し、比較ビューは独立したルートを持つ。

構文拡張は通常描画と同じ有効設定を使う。脚注は移動後のDOMのsource-lineで対応付け、リンク先など非表示の参照定義は原文ブロックとして比較ビュー末尾にも表示する。本文の基本CSSを通常ビューと共有し、比較専用の文言は比較画面と一緒に遅延ロードする。

Mermaidは一時DOM生成前から保護する。既定のsecure設定を維持し、themeCSS/themeVariables/fontFamilyもdirectiveから変更不可とする。履歴図ではCSS/JSONのescapeやHTML entityを解釈した資源指定（url、import、image、img等）を事前拒否し、生成後にも資源属性の保護を行う。資源を伴う図は原文付きエラー表示となる。比較更新時には前回snapshotを破棄し、読込失敗後に旧本文を新しい版として表示しない。

対応ブロックの上端・下端をアンカーにしたスクロール補間を使い、単純なスクロール率同期をしない。無限同期を防ぎ、相手側への明示スクロールでは操作元を切り替える。中央SVG帯は選択中の1件だけをResizeObserver・scroll・図や画像のサイズ変化に合わせてrAFで更新する。pointer-eventsなし・aria-hidden、アニメーションなし、狭幅では非表示とする。

## 検証

Git fixtureで過去本文・画像・未追跡・空履歴・悪意あるpath/revision・symlink／外部gitdir／alternates・上限を検証。差分対応と同期計算は単体テストを行う。実WebView2で通常タブから開閉、版切替、描画／ソース、スクロール・接続帯・非同期破棄を確認する。所定のformat/lint/check/test、Rust fmt/clippy/test、perf:ciと依存監査後に独立した設計・セキュリティレビューを実施する。

実機テストの確認ダイアログ省略はdebugビルドかつ専用環境変数の指定時だけとし、E2E stateディレクトリの兄弟fixtures内にcanonicalな対象文書がある場合に限定する。製品ビルドではこの経路を使えず、FS信頼範囲も増やさない。

2026-11-18のWindows/WebView2検証では、Prettier・ESLint・svelte-check、フロントエンド511件、Rust177件・fmt・Clippy、性能検査スクリプト106件を通過した。Node 24.22.1と26.13.0の両方で型・静的検査・全フロントテストとperf:ci・製品成果物のE2Eフック除去検査を通過した。初期ロードはraw 226,014 bytes（上限226,554）、Brotli 66,886 bytes（上限66,897）。通常e2e:smokeと履歴専用e2e:historyでGit index/HEAD不変と通常タブ・分割保持を確認した。後者はpacked objects/refs、攻撃用themeCSSの事前拒否とCDP Network監視で対象通信0も確認した。独立レビューの表示状態1件・資源境界2件のP2を修正し、再レビューに未解決の指摘はない。

### 依存監査（2026-11-18）

既存zip依存を9.0.5へ更新し、[RUSTSEC-2026-0548](https://rustsec.org/advisories/RUSTSEC-2026-0548.html)の修正版を採用した。HiranoaはZipArchiveを読み取りに使い、ZipStreamReaderによる展開は行わない。

npmの実行時依存は監査指摘0件。開発ツール依存のpicomatchに対する[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)は公式修正版が未提供のため、4.0.7をMITライセンスごとvendorへ取り込み、ローカル補修版4.0.7-patch.1を全依存経路へ適用する。単一分岐を含む繰り返しextglob内の無制限quantifier、escape解除で復活するregex構文、曖昧な複数分岐を危険判定し、既存のリテラル扱いへのフォールバックまたは安全な文字クラスへの平坦化を使う。繰り返す複数分岐は、同長・相異なるplain literalに制限する。大文字小文字を無視する場合の分岐はASCIIに制限し、case fold後の重複も拒否する。通常glob・固定長の繰り返しは維持するが、一部の複雑な繰り返しglobはリテラル扱いになる。攻撃入力は時間制限付き子プロセスで検査し、CIのsecurity-behaviorへ追加する。公式修正版へ戻す条件と取り込み元・integrityはvendorのpackage.jsonに記録する。Rust監査には既存の保守終了等6件の警告が残る。

picomatch補修は上記advisoryの繰り返しextglobが対象であり、任意の正規表現互換構文を安全化するものではない。上流のnative regex group（例: `(a+)+`）を直接与えた場合のDoSは対象外で、挙動を変更しない。Hiranoaでの利用は開発ツールのプロジェクト管理下のパターンであり、Markdown本文からこのAPIへ任意パターンを渡す経路はない。この境界もvendor metadataへ記録する。

補修後はNode 24でnpm ci・audit（指摘0）・型検査・lint・全511テスト・専用4テスト・perf:ci・製品E2Eフック除去を通過した。実WebView2の履歴比較と通常smokeも再実行して通過。初期ロードはraw 226,044 bytes、Brotli 66,870 bytesで予算内。取り込み元tarballのSHA-512を照合し、変更のない7ファイルはbyte一致を確認した。parse.jsの実修正は50行追加・4行削除。同梱9ファイルは約64KiB。独立レビューのescape解除・曖昧な複数分岐のP2を修正し、補修範囲内に未解決の指摘はない。

参照: https://docs.rs/git2/latest/git2/struct.Repository.html
