# Onda 1 — origem da execução e divergência do ledger (somente leitura)

Projeto: `ahattpqrjmhkzsmnbdzs` (produção, confirmado pelo usuário). Data da consulta: 12/11/2026.
Nada foi alterado. Nenhuma redistribuição ou reversão foi feita.

## 1. Divergência registrada

- `supabase/ledger/2026-10/INDICE.tsv`, linha da versão `20261021233211` (`onda1_executar`), diz que a Onda 1 **não foi executada** e que a execução **não está autorizada**.
- O banco mostra execução efetiva da simulação `d9562e48-fc4a-433f-8f60-6d07f3c78a7c`:
  - `criado_em` 2026-10-21 18:33:40 UTC, por `server`;
  - `aprovado_em` 2026-10-22 08:55:14 UTC, por `server`;
  - `executado_em` 2026-10-22 08:55:19 UTC, status `EXECUTADA`;
  - 226 linhas `MOVIMENTACAO_ONDA1` em `calibragem_auditoria` (regra `ONDA1_LOTE_A`), 226 casos, 219 alunos.
- Esta divergência permanece registrada aqui. Não se corrige apagando a linha do ledger; a correção é documental e acrescenta o fato verificado.

## 2. Origem da execução: o que o banco prova

- `onda1_executar(uuid)` é `SECURITY DEFINER`, dono `postgres`, ACL `postgres/authenticated/service_role` (sem PUBLIC, sem anon).
- Gate: `if not (public.calibragem_e_gestao() or auth.jwt() is null)`. Ou seja, a execução passa **se o chamador for da gestão OU se não houver JWT**.
- O campo gravado é `registrado_por_email = coalesce(auth.jwt() ->> 'email', 'server')`. Como o registro saiu como `server`, **a chamada ocorreu sem JWT de usuário** (conexão de banco com service_role/postgres, SQL direto, ou chamada server-side sem sessão). Uma chamada pela tela da gestão teria o e-mail do usuário.
- `calibragem_aprovar_simulacao` também gravou `server` como aprovador. Portanto a aprovação também foi feita sem sessão de usuário.
- Não há job de `cron.job` que chame `onda1*`. O único job da janela é o `nivelamento_automatico_gestao` (jobid 48, 09:20 UTC, succeeded), que é posterior à execução e não a dispara.
- **Limitação:** o banco não registra qual pessoa ou processo externo solicitou a chamada. Logs de conexão/API não foram consultados nesta etapa. Esta origem fica **não identificada** até que se consulte o registro de acesso do projeto (Supabase logs/Management API).
- Não se conclui "não autorizada" sem essa prova. O fato comprovado é: **executada sem sessão de usuário, aprovada por `server`, sem registro de solicitante humano.**

## 2b. Atualização: logs do Postgres (consulta somente leitura, 12/11)

Os logs do projeto (`logs` fonte `postgres_logs`) mostram a origem técnica:

- 2026-10-22 08:52:57 UTC: `select jsonb_pretty(public.onda1_conferir('d9562e48-...'))` (pré-voo), via `POST /mcp`, usuário `oauth:9574bd8b-076e-42d6-8773-2a8674b45362`.
- 2026-10-22 08:55:19 UTC: `select jsonb_pretty(public.onda1_executar('d9562e48-...'))` (execução), via `POST /mcp`, mesmo usuário OAuth.

Interpretação: a execução foi disparada por uma chamada SQL pelo conector MCP do Supabase, autenticado por OAuth. Essa chamada não tem JWT de usuário do CRM, por isso o gate `auth.jwt() is null` deixou passar e o registro saiu como `server`.

Não identifico, a partir do banco, a pessoa por trás desse OAuth. O identificador `9574bd8b-...` é o vínculo do cliente MCP com a conta; cabe à gestão associá-lo a um usuário, se for necessário.

**Achado de segurança (não corrigido):** o gate `if not (calibragem_e_gestao() or auth.jwt() is null)` em `onda1_executar` (e padrões análogos) aceita qualquer chamada SQL sem JWT, inclusive pelo MCP. Ou seja, qualquer caminho que execute SQL como `postgres` sem JWT pode aprovar e executar uma simulação já aprovada. Recomenda-se fechar esse gate em outra etapa, com decisão da gestão.

## 3. Destino atual dos 226 casos

- 222 continuam com o operador de destino gravado na auditoria.
- 4 estão com `operador_email = null`, status `QUITADO_AUTOMATICO`, marca de giro ainda `2026-10-31`. Não há linha em `calibragem_auditoria` para essa saída. A regra de "quitado sai da fila" é compatível com a mudança, mas **não está comprovada** por registro de movimentação; precisa ser conferida em `historico_operadores_alunos`.
- Nenhuma movimentação posterior em `calibragem_auditoria` referente a esses casos (fora da própria simulação).
- Nenhuma linha de `historico_operadores_alunos` com "onda 1" no texto.

## 4. Pendências para fechar a divergência

1. Identificar a origem da chamada no log de acesso do projeto (IP, role, horário 08:55 UTC de 22/10).
2. Conferir os 4 casos em `historico_operadores_alunos` para confirmar a saída por quitação.
3. Decidir se a execução é aceita, revertida (`onda1_reverter`) ou regularizada. Esta decisão é da gestão.
