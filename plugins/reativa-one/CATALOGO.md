# Catálogo de agentes, skills, comandos e hooks

Levantado em **2026-10-26**, por medição. A coluna *Situação de uso* vem de
contagem nos 368 transcripts deste projeto
(`~/.claude/projects/-Users-amandapradoseibel-Documents-crm-reativa-atual/*.jsonl`),
não de estimativa: **existir não é estar em uso.**

Como a medição foi feita, para poder ser repetida:

```bash
cd ~/.claude/projects/-Users-amandapradoseibel-Documents-crm-reativa-atual
grep -ho '"type":"tool_use","id":"[^"]*","name":"Agent"' *.jsonl | wc -l
grep -ho '"subagent_type":"[^"]*"' *.jsonl | sort | uniq -c | sort -rn
grep -ho '"name":"Skill","input":{"skill":"[^"]*"' *.jsonl | sed 's/.*"skill":"//' | sort | uniq -c | sort -rn
```

---

## Agentes

| Nome | Finalidade | Quando utilizar | Disponibilidade | Situação de uso |
|---|---|---|---|---|
| `guardiao` | Audita uma alteração contra as premissas, a premissa de segurança e o checklist de deploy. Devolve APROVADO / REPROVADO com o bloco de conclusão | antes de abrir PR; depois de mexer em RPC/RLS/grant/view/trigger; quando precisar saber se a mudança amplia acesso | plugin `reativa-one` (no repo) | **nunca usado** — plugin não habilitado |
| `desenvolvedor` | Correção pontual e implementação localizada dentro de escopo declarado, com testes do módulo | "corrija esta tela", "ajuste este utilitário", "este botão não faz X" | plugin `reativa-one` (no repo) | **nunca usado** — plugin não habilitado |
| `Explore` | Varredura ampla só-leitura, devolve a conclusão e não o despejo dos arquivos | "onde mais existe esta fórmula de saldo?" | nativo | **em uso — o mais usado** (único tipo com uso pesado) |
| `general-purpose` | Pesquisa e tarefas multi-etapa quando nenhum agente específico encaixa | busca cujo acerto na primeira tentativa é incerto | nativo | **em uso**, bem menos que o `Explore` |
| `claude-code-guide` | Responde sobre Claude Code, Agent SDK e API da Anthropic, consultando a documentação | dúvida de configuração do próprio Claude Code (chave de settings, hook, plugin) | nativo | usado nesta frente, para confirmar as chaves de habilitação do plugin |
| `Plan` | Desenha plano de implementação | frente grande, antes de escrever código | nativo | sem uso registrado |

Agentes de **Banco**, **Operacional**, **Inteligência** e **Entrega** são Fase 2
e **não existem**. Ver "Lacuna" na skill `selecao-de-recursos`.

## Skills

| Nome | Finalidade | Quando utilizar | Disponibilidade | Situação de uso |
|---|---|---|---|---|
| `fontes-de-verdade` | Roteador: diz qual arquivo do repo manda em cada assunto | antes de responder "qual é a regra?"; antes de implementar regra ou fallback | plugin `reativa-one` | **nunca usada** — plugin não habilitado |
| `economia-de-tokens` | Critério objetivo de modelo, esforço e número de subagentes | antes de abrir subagente, varrer arquivo grande ou subir de modelo | plugin `reativa-one` | **nunca usada** — plugin não habilitado, **apesar de o `CLAUDE.md` a exigir** |
| `seguranca-rls` | Caminho obrigatório quando o diff toca banco (RLS, grant, `SECURITY DEFINER`) | função, RPC, view, tabela, trigger, policy, bucket | plugin `reativa-one` | **nunca usada** — plugin não habilitado |
| `selecao-de-recursos` | Qual recurso usar, o que roda em paralelo, quem tem a caneta | pedido que toque mais de um arquivo; antes de abrir subagente; antes de duas frentes juntas | plugin `reativa-one` | **nova nesta versão** |
| `artifact-design` | Design de artifact/página | ao publicar artifact | nativa | **a mais usada de todas** |
| `dataviz` | Gráfico, painel, visualização de dados | antes de escrever a primeira linha de gráfico | nativa | **em uso** |
| `xlsx` / `docx` / `pdf` | Planilha, documento Word, PDF | entrega em arquivo desses formatos | nativa | `xlsx` em uso; `docx` pontual |
| `chrome-browser` / `built-in-browser` | Navegador externo / painel do app | conferir tela publicada, preview | nativa | **em uso** |
| `code-review` / `simplify` / `security-review` | Revisão de diff, limpeza, revisão de segurança | antes de PR | nativa | sem uso registrado — **sobrepõe-se ao `guardiao`**: ver nota |
| `workflow-authoring` | Referência para escrever script do Workflow | antes de autorar workflow | nativa | **em uso** (7 invocações) |
| `consolidate-memory` | Passe de limpeza na memória | memória com duplicata ou fato vencido | nativa | usada 1× |

**Nota sobre sobreposição `guardiao` × `code-review`:** não são a mesma coisa e
nenhuma substitui a outra. `code-review` acha defeito de correção em código
genérico; o `guardiao` confere **as premissas e a premissa de segurança deste
repositório**, cita arquivo e seção, e preenche o bloco de conclusão da §13.
Para diff que toca banco, fila, dinheiro ou acesso, o portão é o `guardiao`.
`code-review` é complemento opcional em código de tela.

## Comandos

| Nome | Finalidade | Quando utilizar | Modelo / esforço | Situação de uso |
|---|---|---|---|---|
| `/reativa-one:ambiente` | PROD × staging, projeto realmente ligado a este checkout, branch, estado dos freios | **antes de qualquer afirmação sobre ambiente** | `haiku` · `low` | nunca usado |
| `/reativa-one:escopo` | Declara (ou mostra) os arquivos que a frente pode editar | antes da primeira edição | `haiku` · `low` | nunca usado |
| `/reativa-one:mapa` | Diz qual arquivo manda no assunto e abre só o trecho | "qual é a regra de X?" | `sonnet` · `low` | nunca usado |
| `/reativa-one:checar` | Auditoria do diff atual, com bloco de conclusão preenchido | portão local antes do PR | — | nunca usado |
| `/reativa-one:corrigir` | Correção pontual com escopo, testes e parada em regra de banco | correção localizada | · `medium` | nunca usado |
| `/reativa-one:autoteste` | Roda os 75 casos de bloqueio do Guardião | depois de mexer em hook ou em `settings.json` | `sonnet` · `low` | executado nesta frente: **75 casos, 0 divergentes** |

Todos em **nunca usado** pela mesma causa única: plugin não habilitado.

## Hooks

| Evento | Script | O que faz | Situação |
|---|---|---|---|
| `PreToolUse` (Bash, Edit, Write, MultiEdit, NotebookEdit, `mcp__`) | `hooks/guardiao.sh` | Bloqueia no instante da chamada o que reescreve produção, publica, mescla, mexe na branch principal, edita o ledger, despeja segredo ou sai do escopo. **Indeterminado nega** | inerte — plugin não habilitado |
| `Stop` | `hooks/aviso-final.sh` | Avisa se a camada de permissões foi alterada na sessão | inerte |
| `PreCompact`, `SessionEnd` | `hooks/marco.sh` | Grava marco técnico (evento, branch, HEAD, escopo, contagem por área) em `.claude/reativa-one.marcos.local.md`. Sem conteúdo, sem valor, sem segredo; `exit 0` sempre | inerte |

## Camada 0 — não depende de plugin

`.claude/settings.json`, versionado: **119 entradas de `deny`** e **76 de `ask`**
(contadas em 2026-10-26 com `JSON.parse` no próprio arquivo), mais
`maxEffortLevel: high` e `env.CLAUDE_CODE_SUBAGENT_MODEL: sonnet`.

> O `CHANGELOG.md` 1.1.0 diz "121 entradas de `deny` e 79 de `ask`". O número
> medido é 119 e 76. A divergência é **anterior** a esta frente: o diff que
> acrescentou `extraKnownMarketplaces` e `enabledPlugins` tem 10 adições e
> **0 remoções**, provado por `git diff --numstat`. Nenhuma regra foi removida;
> o número do CHANGELOG é que está velho.

Sobrevive a plugin desativado, hook com defeito, hook em timeout e sessão nova.
**Nenhuma proibição absoluta mora só no hook.**

> **Ressalva medida:** esta camada só vale onde o arquivo existe. Em um checkout
> que não tenha `.claude/settings.json` — por estar atrás da `main`, por
> exemplo — não há `deny` nem `ask` nenhum, e `settings.local.json` traz apenas
> `allow`. Conferir com `/reativa-one:ambiente` antes de confiar nos freios.
