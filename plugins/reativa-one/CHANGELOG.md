# ReATIVA One — registro de versões

## 1.3.1 — 2026-11-05 (falsos positivos de R5/R7 e de M3)

Dois bloqueios que atingiam **leitura** foram corrigidos. Nenhuma regra nova, nenhum
bloqueio de escrita relaxado, Camada 0 intocada: `.claude/settings.json` não é alterado
por esta versão.

- **R5/R7 — descarte para `/dev/null`.** O portão externo das duas regras casa qualquer
  `>`, e a cópia que ignora redirecionamento só recortava `N>&M`. Consequência:
  `grep -rn x .claude/settings.json 2>/dev/null` — leitura pura — era negado por
  `R5/desarme`. Medido em sessão real de revisão, em 05/11/2026. O recorte passou a
  incluir `>/dev/null` e `N>/dev/null`, **com fronteira obrigatória depois do destino**:
  `>/dev/nullx`, `>/dev/null/../<caminho>` e `>/dev/stderr` nomeiam outro destino, não
  casam e seguem negando. Mesma doutrina da duplicação de descritor (1.3.0) e da isenção
  de `.env.example` em R6: regra que incomoda sem motivo é regra que alguém desliga.
- **M3 — palavra de escrita fora de posição de código.** O filtro de verbo varria a query
  inteira, então consulta de leitura era negada por **citar** a palavra:
  `where acao = 'update'`, `where pg_get_functiondef(oid) ilike '%grant%'`,
  `where tipo in ('insert','delete')`. Entrou `sanitizar_sql()`, que remove **só o que não
  executa** — literal entre apóstrofos, identificador entre aspas duplas e comentário de
  linha e de bloco — e o filtro passou a rodar sobre o resto, que é código. Literal é
  removido **antes** de comentário, senão `select 'a--' ; update t set x=1` seria truncado
  no `--` de dentro do literal e a escrita desapareceria do texto examinado.
- **Dúvida segue negando.** A sanitização é recusada, e o filtro roda sobre a query crua,
  quando há barra invertida (escape de literal muda onde o literal termina), citação por
  dólar (`$$ … $$` é corpo de `DO`/função: executa, não é texto) ou apóstrofo/aspas
  sobrando depois da remoção (literal sem par, ou em várias linhas).
- **`do` e `execute` entraram na lista de verbos de M3**, por causa da sanitização e não
  apesar dela: `do 'update t set x=1' language plpgsql` executa, e com o literal removido
  não restaria verbo para casar. Sem esse par a sanitização abriria caminho de escrita.
- **Perfil de teste de M3 virou estrutural (correção de revisão).** O `rollback` era aceito
  em qualquer lugar da query **crua**, e cinco contornos passavam: `update …; rollback;`
  sem `begin` (autocommit grava e o rollback não faz nada), `begin; …; commit; rollback;`
  (o commit já gravou), e `rollback` dentro de literal ou comentário. A regra exige agora,
  sobre o código sanitizado: começar em `begin`, nenhum `commit`/`end`/`release`, e
  `rollback` como último statement. Esta regra existia na `main` com a mesma falha; a
  correção a fecha, não a introduz.
- **Versão alinhada:** `VERSAO` do hook passa a ser `1.3.1`, igual a este registro.
- **Autoteste: 227 casos (eram 191), 0 divergente.** 36 novos: `G01`–`G13` para o descarte
  de stderr (5 de leitura liberada, 8 provando que toda forma que nomeia outro destino
  segue negada); `Q01`–`Q15` para M3 (7 de leitura liberada, 8 de escrita negada — `;`
  depois de literal, CTE que escreve, `DO` em literal e em dólar, literal aberto, barra
  invertida); `Q16`–`Q22` para o perfil de teste (os cinco contornos acima, mais `update`
  depois do `rollback` e `end` como sinônimo de commit); `Q23` prova que o perfil legítimo,
  com espaços e `;` finais, segue liberado.
- **Limite declarado do perfil de teste:** não cobre efeito externo (`dblink`, função que
  chama outro banco), que `rollback` nenhum desfaz. A execução segue sob `ask` no
  `settings.json`, que é a contenção real desse caso.
- **Não mudou:** nenhuma outra regra do hook, nenhuma entrada de `deny`/`ask`, nenhum
  bloqueio de aplicação. `copy … from` e função de escrita chamada por `select` seguem
  fora da lista de verbos de M3 — lacuna **anterior** a esta versão, não introduzida aqui.

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
