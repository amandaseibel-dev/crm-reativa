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
          deny + ask. Sobrevive a: plugin desativado, plugin removido,
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

```
/plugin marketplace add .
/plugin install reativa-one@reativa
```

`/plugin` é diálogo de terminal: rode num `claude` interativo (no app Claude
Code, a aba de plugins faz o mesmo). Depois, **reabra a sessão** — hook só
carrega no início.

A Camada 0 **não precisa de instalação**: `.claude/settings.json` passa a valer
assim que o arquivo existe no projeto, porque é lido pelo próprio Claude Code.

### Provar que está de pé

1. `node plugins/reativa-one/tests/guardiao.autoteste.mjs` — prova a Camada 1
   (63 casos, nada executado contra produção).
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

## Estado por projeto

`.claude/reativa-one.local.md` guarda o escopo declarado da frente. Não é
versionado e **não guarda segredo**: `escopo.sh` recusa qualquer valor com cara
de credencial (`eyJ…`, `sb_secret_…`, `postgres://`, `service_role`, senha).
Nesta fase **não existe token de autorização** — migration, merge e deploy
estão em negação pura.

## Comandos

| Comando | Para que |
|---|---|
| `/reativa-one:ambiente` | PROD × STAGING × projeto realmente ligado, branch, freios |
| `/reativa-one:escopo` | declara/mostra os arquivos que esta frente pode editar |
| `/reativa-one:mapa` | qual arquivo manda no assunto, e só o trecho que importa |
| `/reativa-one:corrigir` | correção pontual pelo subagente `desenvolvedor` |
| `/reativa-one:checar` | auditoria do diff pelo subagente `guardiao` |
| `/reativa-one:autoteste` | roda os 63 casos de bloqueio |

## Estrutura

```
plugins/reativa-one/
├── .claude-plugin/plugin.json
├── README.md · CHANGELOG.md
├── agents/      guardiao.md · desenvolvedor.md
├── skills/      fontes-de-verdade/ · seguranca-rls/
├── commands/    6 comandos
├── hooks/       hooks.json · guardiao.sh · aviso-final.sh
├── scripts/     ambiente.sh · escopo.sh · integracoes-cinco.sh
└── tests/       guardiao.autoteste.mjs
```

`tests/guardiao.autoteste.mjs` **não** se chama `*.test.mjs` de propósito: o
`vitest` da raiz coletaria o arquivo e a contagem de testes do CI mudaria. Esta
fase não altera `ci.yml` nem `package.json`.
