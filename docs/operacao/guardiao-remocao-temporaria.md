# Guardião ReATIVA One — remoção temporária

Decisão da gestão em 06/11/2026: retirar o Guardião e seus hooks de bloqueio do
fluxo de desenvolvimento do CRM ReATIVA One, **temporariamente**. Nada do código
do Guardião foi excluído — nem arquivo, nem histórico.

## 1. Onde o Guardião se instala e se ativa

| Camada | Arquivo | Papel |
| --- | --- | --- |
| Versionada | `plugins/reativa-one/hooks/hooks.json` | **registra os hooks** — é o único ponto que faz o Guardião rodar |
| Versionada | `plugins/reativa-one/hooks/guardiao.sh` | motor dos bloqueios (R1–R7, P6/escopo) |
| Versionada | `plugins/reativa-one/hooks/aviso-final.sh` | aviso de fim de sessão sobre a camada de permissões |
| Versionada | `.claude/settings.json` | `extraKnownMarketplaces.reativa` + `enabledPlugins["reativa-one@reativa"]` — habilita o **plugin inteiro** |
| Local (não versionada) | `~/.claude/settings.json` | mesma dupla, no nível do usuário; marketplace aponta para `crm-reativa-main` |
| Local (cache do app) | `~/.claude/plugins/known_marketplaces.json`, `installed_plugins.json`, `cache/reativa/reativa-one/1.2.0/` | registro e cópia de trabalho do plugin, gerida pelo Claude Code |

O plugin `reativa-one` **não é só o Guardião**. Ele também carrega o agente
`desenvolvedor`, as skills `economia-de-tokens`, `selecao-de-recursos`,
`fontes-de-verdade` e `seguranca-rls`, e os comandos `/escopo`, `/mapa`,
`/ambiente`, `/corrigir`, `/checar`, `/autoteste` — todos exigidos pelo
`CLAUDE.md`. Por isso a remoção foi feita **nos hooks**, não no plugin.

## 2. O que esta alteração desativa

Retirados de `hooks/hooks.json`:

- `PreToolUse` em `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit` e `mcp__`
  — todos os bloqueios no instante da chamada: produção, publicação, merge,
  branch principal, ledger, segredo, escopo declarado (P6);
- `Stop` → `aviso-final.sh` — o aviso de fim de sessão.

O bloco retirado está preservado **integralmente** em
`plugins/reativa-one/hooks/hooks.json.guardiao-ativo`, ao lado. Os scripts
`guardiao.sh` e `aviso-final.sh` continuam no repositório, intactos, apenas sem
gatilho.

## 3. O que continua funcionando

- **Camada de permissões do Claude Code** — `.claude/settings.json` (`deny` /
  `ask`) e `.claude/settings.local.json` (`allow`) seguem valendo, inalteradas.
  Os `deny` de `supabase db push`, `db reset`, `migration repair`, `vercel`,
  `gh pr merge`, `git push --force`, `git reset --hard`, leitura de `.env` e
  edição do ledger **não dependem do Guardião** e continuam ativos.
- Marco de estado técnico em `PreCompact`/`SessionEnd` (`marco.sh`) — não
  bloqueia nada e pertence à política de economia de token.
- Plugin `reativa-one` inteiro: agente `desenvolvedor`, as quatro skills e todos
  os comandos, inclusive `/escopo` (que passa a ser declaração informativa, sem
  recusa automática) e `/checar` (auditoria por leitura, que nunca dependeu dos
  hooks).
- Agente `guardiao` (`plugins/reativa-one/agents/guardiao.md`) — segue
  disponível como **revisor sob demanda**; ele nunca foi um hook.
- Autoteste `plugins/reativa-one/tests/guardiao.autoteste.mjs` e
  `scripts/ci/teste-guardiao-apply-migration.sh` — preservados; não estão
  ligados a nenhum workflow de CI.

## 4. Como reinstalar o Guardião

Uma linha, no repositório:

```bash
cp plugins/reativa-one/hooks/hooks.json.guardiao-ativo plugins/reativa-one/hooks/hooks.json
```

Ou, equivalente, pelo histórico do Git:

```bash
git show <commit-desta-remocao>^:plugins/reativa-one/hooks/hooks.json > plugins/reativa-one/hooks/hooks.json
```

Depois:

1. commitar a volta (`fix(guardiao): reativa os hooks de bloqueio`);
2. **reiniciar o Claude Code** — o app lê `hooks.json` do cache do plugin
   (`~/.claude/plugins/cache/reativa/reativa-one/1.2.0/`) na abertura da sessão;
   sem reiniciar, o estado anterior continua em vigor;
3. conferir com `/reativa-one:autoteste` (75 casos, nenhum contra produção);
4. conferir na prática: um `Bash` de `supabase db push` deve voltar a ser
   recusado com `[R1]`.

Quando o cache não refletir o repositório, forçar a releitura do marketplace
`reativa` por `/plugin` no app (o marketplace é `directory`, aponta para o
próprio checkout).

## 5. Limites desta alteração

- Não toca dados financeiros, acordos, pagamentos ou baixas.
- Não executa migration nem SQL de produção.
- Não faz merge nem deploy.
- Não exclui código nem histórico do Guardião.
- Não remove nenhum outro plugin, skill, agente, comando ou permissão.
