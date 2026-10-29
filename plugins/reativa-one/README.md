# ReATIVA One — Fase 1 (Guardião e Desenvolvedor)

Plugin de uso exclusivo no desenvolvimento do CRM ReATIVA. Esta fase entrega
**duas** especializações: o **Guardião** (segurança e prevenção) e o
**Desenvolvedor** (correção pontual). Banco, Operacional, Inteligência e
Entrega são Fase 2 e **não** existem aqui.

**Nenhuma regra de negócio é duplicada neste diretório.** As skills apontam
para `docs/` do repositório. Regra escrita duas vezes é regra que divergiu.

---

## Três camadas, e por que a proteção não mora no plugin

```
CAMADA 0  .claude/settings.json   VERSIONADO · independe deste plugin
          deny + ask, mais o teto de esforço e o modelo padrão de
          subagente. Sobrevive a: plugin desativado, plugin removido,
          hook com defeito, hook em timeout, sessão nova, outra máquina
          que faça git pull.
CAMADA 1  plugins/reativa-one/hooks/guardiao.sh
          o que a Camada 0 não sabe expressar: escopo declarado, ledger,
          nome de migration, URL de destino, comando que chega pelo
          terminal do app. Indeterminado = NEGA.
CAMADA 2  CI  — Fase 2, autorização separada.
```

**Regra de ouro: nenhuma proibição absoluta mora só na Camada 1.** Um hook que
estoura o timeout **não** bloqueia — hook lento vira hook ausente. Por isso
`db push`, `apply_migration`, deploy, merge, push em `main` e leitura de `.env`
estão também na Camada 0.

Consequência prática: **desativar ou remover este plugin não destrava nada.**
Perde-se conveniência (comandos, agentes, escopo), não proteção.

---

### Dois nomes para o mesmo conector

A Camada 0 casa por **nome exato** da ferramenta. O mesmo conector do claude.ai
tem dois nomes: o id em UUID no app desktop (`mcp__3e1f85b1-…__apply_migration`)
e `mcp__claude_ai_<Nome>__<ferramenta>` na linha de comando
(`mcp__claude_ai_Supabase__apply_migration`). Por isso cada regra do Supabase
existe nas duas formas. O hook (Camada 1) casa pelo **sufixo** e cobre as duas,
mas só vale com o plugin ativo.

- O teste `S02` do autoteste falha se uma forma existir sem a outra.
- Supabase e Vercel têm os dois nomes (nomes da CLI confirmados no teste L1:
  `tests/L1-roteiro.md`).
- Se o nome de exibição do conector mudar, a Camada 0 deixa de casar e só o hook
  protege. Refazer a lista e o `S02` quando isso acontecer.
- Ferramentas só da CLI: `create_edge_function_secret` (Supabase) não consta da
  lista do conector no app desktop e por isso só tem a regra `claude_ai_Supabase`
  (exceção declarada no teste S02).
- **Limitação conhecida:** `execute_sql` está em `ask`, e a exigência de
  aprovação nunca foi demonstrada. A Camada 0 não é declarada plenamente segura
  enquanto isso valer. O hook (Camada 1) também **não** barra
  `create_edge_function_secret`; quem a nega é só a Camada 0.

### Sessões de análise: desligar o conector Supabase completo

A Camada 0 vale para todas as sessões e mantém `execute_sql` em `ask` para
preservar o uso administrativo autorizado. Como o `ask` não foi demonstrado
como exigência de aprovação (J1–J13), **ele não é a proteção das sessões de
análise ou auditoria**. Essas sessões devem ser abertas **sem o conector
Supabase completo** e usar somente o conector de leitura (`supabase-leitura`,
com `read_only=true`):

- **CLI:** pasta própria com `.claude/settings.json` contendo
  `"disableClaudeAiConnectors": true` (nenhum conector do claude.ai é carregado
  ali; `claude mcp list` mostra só o servidor do projeto) e `deny` do conector
  completo nos dois formatos de nome.
- **App desktop:** desativar o conector Supabase completo para a sessão.
- **Agentes** (Guardião, Desenvolvedor, futuro Analista de Banco): `tools:`
  fechado, sem Bash nem escrita onde não couber.

A configuração de referência (`supabase-leitura-isolado`) ainda **não está
versionada** neste repositório. Ela não protege dados pessoais: o papel de leitura
enxerga também o schema `auth`; isso só um papel PostgreSQL dedicado resolve.

---

## O que o Guardião bloqueia, e por onde

Casado por **sufixo** do nome da ferramenta de MCP, não pelo id do conector:
se o conector for recriado com outro id, a regra continua valendo.

| Caminho | Coberto |
|---|---|
| `Bash` | db push/reset/repair · Vercel CLI · `gh pr merge` · merge pela API · push forçado/para `main` · qualquer escrita de histórico com HEAD em `main` · `reset --hard`, `clean -fd`, `stash pop` · redirecionamento para ledger/migrations/settings/.git · `printenv` e leitura de `.env` · POST na REST de produção · `psql` em produção |
| `Edit` / `Write` / `MultiEdit` / `NotebookEdit` | ledger · `settings.local.json` · `supabase/migrations/` · `.git/` · nome de migration com `__` · fora do escopo declarado |
| MCP Supabase | `apply_migration`, `deploy_edge_function`, `pause/restore_project`, `*_branch`, `confirm_cost` · `execute_sql` com verbo de escrita sem `rollback` |
| MCP Vercel | `create_deployment`, `request_promote/rollback`, `assign_alias`, rolling release, env e firewall |
| Terminal do app | a linha de comando é reavaliada pelas **mesmas** regras de `Bash` |
| Navegador (Chrome e embutido) | navegação para o SQL Editor e para a REST de produção · `javascript_tool` chamando a API |
| Sessão na nuvem | `start_session` com `target: cloud` — lá nenhum hook deste plugin existe |

Contorno por citação não funciona: o avaliador trabalha sobre o **esqueleto** do
comando, sem aspas nem barras de escape, e varre a linha inteira (inclusive
depois de `&&`, `;` e `|`).

### Excessos conhecidos, declarados

- Um `echo` que apenas **cita** `supabase db push` é bloqueado. Nega por
  excesso, de propósito: o caso B63 do autoteste registra isso.
- `python3 -c` e `node -e` seguem podendo tudo. Não são bloqueados por texto:
  estão em **`ask`** na Camada 0, porque aprovação humana é o freio adequado
  para execução arbitrária.
- Se uma aba de navegador **já estiver aberta** no SQL Editor, o hook vê a
  navegação, não os cliques seguintes. Limitação real, não coberta.

---

## Instalar

O plugin mora no próprio repositório; o marketplace local é
`.claude-plugin/marketplace.json` na raiz.

**Desde a 1.2.0 a habilitação é versionada.** `.claude/settings.json` traz:

```json
"extraKnownMarketplaces": { "reativa": { "source": { "source": "directory", "path": "." } } },
"enabledPlugins": { "reativa-one@reativa": true }
```

Quem faz `git pull` não precisa instalar nada — **com uma condição**: a pasta
tem de ser confiada no diálogo de *workspace trust*, que aparece uma vez, em
sessão interativa. Não existe chave de repositório que o dispense. Até o
diálogo ser aceito, só a Camada 0 vale e o resto do plugin fica inerte.

Rota manual, ainda válida se a habilitação versionada não pegar neste build:

```
/plugin marketplace add .
/plugin install reativa-one@reativa
```

`/plugin` é diálogo de terminal: rode num `claude` interativo (no app Claude
Code, a aba de plugins faz o mesmo). Depois, **reabra a sessão** — hook só
carrega no início.

**Em worktree o caminho relativo resolve contra o checkout principal**, não
contra a worktree: alteração feita em worktree só vale depois de entrar na
`main`.

O que cada recurso faz, quando usar e se está realmente em uso:
[`CATALOGO.md`](CATALOGO.md).

A Camada 0 **não precisa de instalação**: `.claude/settings.json` passa a valer
assim que o arquivo existe no projeto, porque é lido pelo próprio Claude Code.

### Provar que está de pé

1. `node plugins/reativa-one/tests/guardiao.autoteste.mjs` — prova a Camada 1
   (75 casos, nada executado contra produção).
2. Sentinelas da Camada 0, inofensivas por desenho:

   | Tentar | Esperado |
   |---|---|
   | `echo SENTINELA_DENY_DOISPONTOS ok` | bloqueado (forma `cmd:*`) |
   | `echo SENTINELA_DENY_ESPACO ok` | bloqueado (forma `cmd *`) |
   | `echo SENTINELA_DENY_EXATO` | bloqueado (forma exata) |
   | `echo SENTINELA_ASK_DOISPONTOS ok` | pede aprovação |
   | `echo SENTINELA_ASK_ESPACO ok` | pede aprovação |

   Se uma sentinela **executar**, aquela forma de escrever a regra não é
   honrada por este build — e as regras escritas naquela forma são letra morta.
   É por isso que cada regra crítica está gravada nas duas formas.
3. `bash plugins/reativa-one/scripts/ambiente.sh` — diz se as duas camadas
   estão presentes em arquivo (presença de arquivo **não** prova hook ativo).
4. **Provar que a habilitação pegou** — presença das chaves em
   `.claude/settings.json` não basta:

   | Rodar | Esperado |
   |---|---|
   | `claude plugin marketplace list` | lista `reativa` |
   | `claude plugin list` | lista `reativa-one@reativa` como *enabled* |
   | `/status`, linha "Setting sources" | cita o settings do projeto |
   | `/plugin`, aba Errors | vazia |

   Se `reativa` **não** aparecer, o diálogo de confiança não foi aceito (ou
   `path: "."` não é honrado neste build — trocar pelo caminho absoluto do
   checkout e repetir). `claude plugin validate .` e
   `claude plugin validate plugins/reativa-one` conferem os manifestos, mas
   **não** provam carregamento.

---

## Atualizar

```
git pull
```

Suba `version` em `.claude-plugin/plugin.json`, registre em `CHANGELOG.md` e
**reabra a sessão**. Editar `hooks/**` está em `ask`: a alteração aparece no
diff e precisa do seu clique — o Guardião não se reescreve em silêncio.

## Desativar

```
/plugin disable reativa-one
```

Caem os comandos, os agentes, as skills e os hooks. **A Camada 0 permanece.**
Depois de desativar, as sentinelas de `deny` continuam bloqueadas e o autoteste
da Camada 1 deixa de refletir a sessão (o arquivo continua passando, porque
testa o script, não o carregamento).

## Reverter

O plugin e a Camada 0 entram em **commits separados**, nesta ordem:

1. `seguranca: camada 0 …` — só `.claude/settings.json`
2. `plugin: reativa-one fase 1 …` — só `plugins/` e `.claude-plugin/`

Reverter (2) remove o plugin e **não** reabre permissão nenhuma. Reverter (1) é
decisão explícita, isolada, e reabre tudo o que ela fechava.

`.claude/settings.local.json` **não é versionado** (o gitignore global da
máquina o ignora) e **não foi tocado** por esta fase: as 397 entradas de
`allow` seguem exatamente como estavam. A Camada 0 não precisou apagá-las,
porque `deny` e `ask` vencem `allow`.

---

## Economia de token

**Menor consumo que preserve qualidade, segurança e precisão.** A política vive
em três lugares, pelo mesmo critério das três camadas: o que precisa valer
sempre não mora no plugin.

| Onde | O que faz | Sobrevive ao plugin desligado? |
|---|---|---|
| `.claude/settings.json` | `maxEffortLevel: "high"` (teto) e `env.CLAUDE_CODE_SUBAGENT_MODEL: "sonnet"` (padrão de subagente) | **sim** |
| `CLAUDE.md` | três linhas de orientação, sempre em contexto | **sim** |
| `skills/economia-de-tokens/` | o critério objetivo de modelo, esforço e número de agentes | não |
| `commands/*.md` e `agents/*.md` | `model:`/`effort:` por invocação — a parte determinística | não |

O teto é **teto, não trava**: `low`, `medium` e `high` seguem livres; `xhigh` e
`max` passam a exigir edição de arquivo versionado. `maxEffortLevel` clampa
`/effort`, `/model`, `--effort` e `CLAUDE_CODE_EFFORT_LEVEL`, e entre arquivos
de settings vence o **menor** valor. Nenhum arquivo deste plugin pede `max`:
seria clampado, e política que se contradiz na própria pasta é ruído.

`CLAUDE_CODE_SUBAGENT_MODEL` é **padrão**, não imposição: o `model:` de cada
agente continua vencendo — é o que mantém o `guardiao` em `inherit`. Por isso
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` **não** é usado aqui: ele ignoraria o
frontmatter e rebaixaria a auditoria junto com a busca.

**O modelo da sessão principal não é mexido** por esta fase. Modelo e esforço
da sessão são escolha da gestão; o que o plugin governa é subagente, comando e
disciplina de leitura.

### Marco antes de resumir ou limpar

`hooks/marco.sh` roda em `PreCompact` e `SessionEnd` e grava uma linha em
`.claude/reativa-one.marcos.local.md`: evento, gatilho, branch, HEAD, escopo
declarado e **contagem** de arquivos alterados por área.

- **Não bloqueia** — `exit 0` em todo caminho, inclusive de erro. Compactar é o
  que mantém sessão longa viva.
- **Não guarda conteúdo** — do payload do hook só saem dois rótulos de
  vocabulário fechado (evento e gatilho); qualquer outro valor vira
  `indeterminado`. Sem nome, CPF, valor, segredo, caminho absoluto da máquina
  ou trecho de conversa. Caminho de arquivo não entra: só o diretório de
  primeiro nível.
- **Não imprime nada** — marco não custa contexto.
- **Não é fonte.** Vale a regra de ouro: hook em timeout não roda, então
  decisão vira ledger, doc ou PR no momento em que é tomada.

### Provar a economia

| Verificar | Como | Falha se |
|---|---|---|
| settings válido | `claude doctor` na raiz | aponta chave inválida |
| teto de esforço | `/effort max` num `claude` interativo | `max` é aceito |
| padrão de subagente | `echo "${CLAUDE_CODE_SUBAGENT_MODEL:-vazio}"` | vem vazio |
| gasto por modelo | `/usage` (= `/cost`, `/stats`) depois de uma tarefa com subagente | subagente gastou no modelo forte |
| skill carregada | `/skills` lista `economia-de-tokens` | sessão não foi reaberta |
| marco | `/hooks` mostra `PreCompact` e `SessionEnd`; `/compact` grava linha `manual`, `/clear` grava `clear` | arquivo não ganha linha |

`/hooks` e `/config` são diálogos de terminal: rode num `claude` interativo.

---

## Estado por projeto

`.claude/reativa-one.local.md` guarda o escopo declarado da frente. Não é
versionado e **não guarda segredo**: `escopo.sh` recusa qualquer valor com cara
de credencial (`eyJ…`, `sb_secret_…`, `postgres://`, `service_role`, senha).
Nesta fase **não existe token de autorização** — migration, merge e deploy
estão em negação pura.

## Comandos

| Comando | Para que | Modelo · esforço |
|---|---|---|
| `/reativa-one:ambiente` | PROD × STAGING × projeto realmente ligado, branch, freios | haiku · low |
| `/reativa-one:escopo` | declara/mostra os arquivos que esta frente pode editar | haiku · low |
| `/reativa-one:mapa` | qual arquivo manda no assunto, e só o trecho que importa | sonnet · low |
| `/reativa-one:corrigir` | correção pontual pelo subagente `desenvolvedor` | agente: sonnet · medium |
| `/reativa-one:checar` | auditoria do diff pelo subagente `guardiao` | agente: `inherit` · high |
| `/reativa-one:autoteste` | roda os 75 casos (bloqueios e verificações da Camada 0) | sonnet · low |

## Estrutura

```
plugins/reativa-one/
├── .claude-plugin/plugin.json
├── README.md · CHANGELOG.md
├── agents/      guardiao.md · desenvolvedor.md
├── skills/      fontes-de-verdade/ · seguranca-rls/ · economia-de-tokens/
├── commands/    6 comandos
├── hooks/       hooks.json · guardiao.sh · aviso-final.sh · marco.sh
├── scripts/     ambiente.sh · escopo.sh · integracoes-cinco.sh
└── tests/       guardiao.autoteste.mjs
```

`tests/guardiao.autoteste.mjs` **não** se chama `*.test.mjs` de propósito: o
`vitest` da raiz coletaria o arquivo e a contagem de testes do CI mudaria. Esta
fase não altera `ci.yml` nem `package.json`.
