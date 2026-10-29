# ReATIVA One — registro de versões

## 1.3.0 — 2026-10-29 (Fase 2 de Banco — portão de desenvolvimento de migration)

Libera `Write`/`Edit` de migration em worktree e branch nomeados pela gestão, sem
alterar nenhum bloqueio de aplicação. Autoteste validado com 163 casos, 0 divergente.

- **Portão `fase2_liberada()`** em `hooks/guardiao.sh`: ativado pela variável de ambiente
  `REATIVA_FASE2_BANCO` (`<raiz>|<branch>`), definida no lançamento da sessão executora.
  Verificações obrigatórias: worktree vinculado (git-dir ≠ git-common-dir), branch
  autorizada, caminho real dentro de `supabase/migrations/` do worktree, `main`/`master`
  recusados mesmo que nomeados. Fail-closed em qualquer indeterminação.
- **Camada 0 intocada**: nenhuma entrada de `deny`/`ask` alterada. Os 12 bloqueios de
  aplicação (`apply_migration`, `db push`, `db reset`, deploy, merge, etc.) foram
  confirmados com o portão aberto pelo autoteste.
- **`docs/RUNBOOK-MIGRATIONS.md`**: documento que existia como referência morta desde
  1.0.0 foi criado. Seção 9 cobre a Fase 2 de Banco: o que libera, como autorizar, por
  que variável de ambiente e não arquivo, e os limites conhecidos registrados sem esconder.
- **Autoteste:** 163 casos (eram 75). F01–F88 são os 88 casos da Fase 2 de Banco.
  12 deles provam que nenhum bloqueio de aplicação foi relaxado com o portão aberto.
- **`tests/RESULTADO-FASE-2.md`**: resultado de segurança gravado nesta sessão.
  163/163 APROVADO.

**Limitação nova, declarada:** a variável `REATIVA_FASE2_BANCO` não é testada pelo
autoteste — ela precisa estar no ambiente do processo pai do hook, definida no lançamento.
O autoteste simula o portão **com a variável já resolvida**; a prova de que o lançamento
a entrega corretamente fica com a gestão. Não há forma automatizada de testar isso sem
criar uma sessão completa.

**Limitações anteriores, não resolvidas:** `execute_sql` em `ask` sem prova interativa;
habilitação do plugin sem prova de carregamento no checkout principal.

## 1.2.0 — 2026-10-26 (habilitação versionada e seleção de recursos)

**O achado que motivou esta versão:** o plugin estava completo no repositório e
**inerte**. Nenhum `extraKnownMarketplaces` e nenhum `enabledPlugins` existia em
nenhum arquivo de settings — nem no repo, nem em `~/.claude/settings.json`, que
só habilita `frontend-design`. Medição nos 368 transcripts do projeto: **zero**
invocação dos agentes, das skills e dos comandos deste plugin; os únicos
subagentes com uso são os nativos `Explore` e `general-purpose`. O `CLAUDE.md`
exigia a skill `economia-de-tokens` desde a 1.1.0 — uma skill que nunca carregou.

- **Habilitação versionada** em `.claude/settings.json`: `extraKnownMarketplaces`
  (`reativa`, `source: directory`, `path: "."`) e
  `enabledPlugins` (`reativa-one@reativa: true`). O diff tem **10 adições e 0
  remoções**, provado por `git diff --numstat`: nenhuma regra de `deny`/`ask`
  tocada, e o autoteste segue **75 de 75, 0 divergente**.
- **Skill nova `selecao-de-recursos`**: a terceira perna que faltava. As três se
  encadeiam — `fontes-de-verdade` diz *o que* manda, `selecao-de-recursos` diz
  *quem* faz, `economia-de-tokens` diz *quanto* custa. Traz o roteador pedido →
  recurso, o contrato de coordenação, as quatro condições de paralelismo e a
  tabela de quem tem a caneta por arquivo.
- **`CATALOGO.md`**: nome, finalidade, quando usar, disponibilidade e situação de
  uso de cada recurso, com o comando da medição no próprio arquivo. Registra a
  sobreposição `guardiao` × `code-review` e por que nenhuma substitui a outra.
- **`CLAUDE.md`**: seção permanente "Seleção de recursos e paralelismo", cinco
  itens, no padrão enxuto da seção de economia de token.
- Corrige `/reativa-one:autoteste`, que anunciava 63 casos — são 75 desde
  2026-10-16.
- **Correção de número:** o registro da 1.1.0 abaixo afirma "121 entradas de
  `deny` e 79 de `ask`". O valor medido no arquivo é **119 e 76**. A divergência
  é anterior a esta versão e nada foi removido aqui; a afirmação de 1.1.0 é que
  está velha.

**Limitação declarada, não resolvida:** não foi possível **provar** que a
habilitação carrega. A documentação exige que a pasta seja confiada no diálogo
interativo de workspace trust, e não há chave de repositório que o dispense.
Teste feito em sandbox isolado (cópia do marketplace e do plugin, com e sem
`git init`): `claude plugin marketplace list` **não** registrou `reativa` em
nenhum dos dois casos. `claude plugin validate` passa no marketplace e no
plugin. Enquanto o diálogo não for aceito uma vez no checkout principal, a
Camada 0 continua valendo e o resto do plugin continua inerte. Também não está
documentado o literal `path: "."` — se falhar, trocar pelo caminho absoluto do
checkout.

**Armadilha de worktree (documentada):** o caminho relativo resolve contra o
checkout **principal**, não contra a worktree. Alteração feita em worktree só
passa a valer depois de entrar na `main`.

## 1.1.0 — 2026-10-17 (política de economia de token)

Não muda nenhuma regra de bloqueio: as 121 entradas de `deny` e as 79 de `ask`
da Camada 0 ficam **byte a byte** como estavam, e `hooks/guardiao.sh` não é
tocado. Também **não muda o modelo padrão da sessão principal** — isso é
escolha da gestão.

- **Camada 0** (`.claude/settings.json`): duas chaves novas.
  `maxEffortLevel: "high"` é teto, não trava — clampa `/effort`, `/model`,
  `--effort` e `CLAUDE_CODE_EFFORT_LEVEL`, e entre arquivos de settings vence o
  menor valor. `env.CLAUDE_CODE_SUBAGENT_MODEL: "sonnet"` é o **padrão** de
  subagente; o `model:` de cada agente continua vencendo, e por isso
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` não é usado: ele rebaixaria o `guardiao`.
- **Skill `economia-de-tokens`**: critério objetivo de modelo (`haiku` para
  saída de script, `sonnet` como padrão, modelo da sessão só para banco,
  segurança, dinheiro, fila, Prime/ULBRA e auditoria de PR), de esforço e de
  quantos subagentes cabem. Sem `allowed-tools`, de propósito: política
  consultada no meio de uma correção não pode tirar ferramenta de quem corrige.
- **Frontmatter** em 7 arquivos: `ambiente`/`escopo` em `haiku · low`,
  `mapa`/`autoteste` em `sonnet · low`, `corrigir` em `medium`,
  `desenvolvedor` passa de `inherit` para `sonnet · medium`, `guardiao`
  **mantém** `inherit` e ganha `effort: high` — auditoria de RLS/grant é onde
  errar custa mais que o token.
- **`CLAUDE.md`**: três linhas de orientação, o único canal que está sempre em
  contexto no instante em que se decide abrir agente ou ler arquivo.
- **`hooks/marco.sh`** em `PreCompact` e `SessionEnd`: grava evento, gatilho,
  branch, HEAD, escopo e contagem de arquivos por área em
  `.claude/reativa-one.marcos.local.md` (não versionado). Não bloqueia
  (`exit 0` em todo caminho), não imprime nada e não guarda conteúdo — do
  payload só saem dois rótulos de vocabulário fechado; o resto vira
  `indeterminado`.
- Não altera `ci.yml`, `package.json`, `src/`, `supabase/`, `docs/` nem
  `scripts/`. A única linha fora de `plugins/`, `.claude/` e `CLAUDE.md` é a
  segunda entrada de `.gitignore`, para o arquivo de marcos.

## Não lançado — 2026-10-16 (correção dos nomes de conector na CLI)

Sem mudança de versão. Teste L1 executado: ver `tests/L1-roteiro.md`.

- **Camada 0** (`.claude/settings.json`, commits separados): as regras do
  Supabase e do Vercel citavam só o id em UUID do app desktop. Na linha de
  comando o conector do claude.ai se chama `claude_ai_Supabase` /
  `claude_ai_Vercel`, e a regra por nome exato não casava. Cada regra UUID
  ganhou o par `claude_ai_*` (Supabase: 11 `deny` e `execute_sql` em `ask`;
  Vercel: 17 `deny`). Nenhuma regra removida, nenhuma permissão ampliada.
- **Autoteste:** 75 casos (eram 63). C01–C09 repetem B39–B47 com o prefixo da
  CLI e cobrem `create_project` do Vercel; S01–S03 leem o `settings.json`: JSON
  válido, os dois nomes por conector e as ferramentas achadas no L1.
- **Limitação conhecida, não resolvida:** `execute_sql` continua em `ask` e a
  exigência de aprovação nunca foi demonstrada. A Camada 0 **não é declarada
  plenamente segura** enquanto isso valer.
- **Achados do L1 tratados:** `create_edge_function_secret` (Supabase, só na CLI,
  com o nome `claude_ai_Supabase`) e `create_project` do Vercel (UUID e
  `claude_ai_Vercel`) agora estão em `deny`. O hook não barra
  `create_edge_function_secret`; só a Camada 0.
- **Sessões de análise:** o README passa a exigir que desliguem o conector
  Supabase completo, sem depender do `ask` de `execute_sql`.

## 1.0.0 — 2026-10-16 (Fase 1)

Primeira versão. Entrega **Guardião** e **Desenvolvedor**; as outras quatro
especializações são Fase 2 e não existem neste pacote.

- **Camada 0** (`.claude/settings.json`, versionado): `deny` para o que
  reescreve produção, publica, mescla ou expõe segredo; `ask` para execução
  arbitrária com escrita ou acesso externo. As 397 entradas de `allow` de
  `.claude/settings.local.json` **não foram alteradas** — `deny` e `ask` vencem
  `allow`, então não foi preciso mexer no arquivo pessoal e não versionado.
- **Camada 1** (`hooks/guardiao.sh`): 20 regras cobrindo Bash, Edit/Write,
  MCP por sufixo, terminal do app, navegador e sessão na nuvem. Indeterminado
  nega. Nenhuma proibição absoluta depende só desta camada.
- Agentes `guardiao` (sem Edit/Write) e `desenvolvedor` (escopo obrigatório,
  parada quando a correção exige regra no banco).
- Skills `fontes-de-verdade` e `seguranca-rls`: ponteiros para `docs/`, zero
  regra duplicada.
- 6 comandos; 3 scripts; autoteste com 63 casos.
- **Sem token de autorização nesta fase**: migration, merge e deploy ficam em
  negação pura.
- Não altera `ci.yml`, `package.json`, `src/`, `supabase/`, `docs/` nem
  `scripts/`. A única linha fora de `plugins/` e `.claude/` é uma entrada de
  `.gitignore` para o arquivo de estado por projeto.
