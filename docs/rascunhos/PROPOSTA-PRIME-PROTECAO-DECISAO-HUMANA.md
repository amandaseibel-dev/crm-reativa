# Proposta — proteção de decisões humanas e separação de autoria na liquidação Prime

**Status:** pendente de aprovação e de parecer do Guardião. **Não aplicada em produção.** Sem merge e sem deploy.

**Independente da #942** (otimização da seleção). Não misturar.

**Privacidade:** este documento contém apenas agregados. Identificadores de título, de boleto, CPF e valores individualizados ficam fora do repositório, com a gestão. As consultas abaixo são reproduzíveis e somente leitura.

---

## 1. Problema

`prime_liquidacao_suspender` gravava `INSERT ... ON CONFLICT DO UPDATE` sobre `prime_conferencia_decisao` **sem condição sobre a decisão anterior**. Uma decisão humana podia voltar a `PENDENTE` com o autor apagado.

`prime_liquidacao_reavaliar_pendentes` gravava `REJEITADO` com `decidido_por = p_quem`. Quando quem chamava era uma pessoa, a rejeição automática passava a parecer humana, e uma nova liquidação válida não conseguia reabrir o título.

**Medido (agregado):** 10 títulos com decisão humana revertida para `PENDENTE` por suspensão automática, sem ação humana posterior. Valor total R$ 2.389,14, 3 alunos. Detalhamento individual fora do repositório.

## 2. Modelo de autoria

- **Autoria da rotina:** a constante `prime_liquidacao@rotina` em `decidido_por`. Vale para `PENDENTE` criada pela suspensão e para `REJEITADO` criada pela reversão automática.
- **Autoria humana:** qualquer `decidido_por` diferente da constante.
- **Decisão desconhecida** (fora de `PENDENTE`, `REJEITADO`, `VINCULADO`, `CONFIRMADO`, `ENCERRADO_ADMINISTRATIVO`, `DEVOLVIDO`), ou `REJEITADO` sem autor: tratada como **humana** (conservador).
- **Linhas antigas não são reclassificadas.** Um `REJEITADO` antigo com e-mail em `decidido_por` fica como humano, sem evidência de origem.

## 3. Regras

**Suspender**
- Autoria humana: não altera decisão, autor, data nem situação; não grava movimentação; registra tentativa em auditoria, no máximo uma por título por dia; devolve `DECISAO_HUMANA_PRESERVADA`.
- `PENDENTE` da rotina: fluxo normal.
- `REJEITADO` da rotina: **pode ser reaberto** por nova liquidação válida, porque a rejeição não foi humana.

**Reavaliar**
- Só reavalia `PENDENTE` da rotina.
- A reversão grava `REJEITADO` com autor da rotina, **nunca** com quem chamou.
- Informa `ignoradas_decisao_humana`.

## 4. Concorrência

Ordem única de travas: **título (`FOR UPDATE` em `acordos_titulos`), depois decisão (`FOR UPDATE` em `prime_conferencia_decisao`)**. A reavaliação percorre os títulos por `titulo_id` crescente, com desempate determinístico. Reconfere o estado depois de travar.

O encerramento administrativo já usa a mesma ordem (título → decisão), segundo o Guardião.

**Não testado em concorrência real.** Ver seção 6.

## 5. Testes

Arquivo: `supabase/tests/prime_protecao/protecao.test.mjs`. Roda em PGlite, sem produção.

- Versão corrigida: **23 aprovados, 0 falhas**.
- Versão anterior (`--baseline`): **16 falhas**, nos casos de autoria humana, de reversão com autor de chamador, de chave de contagem e de estrutura de travas e ACL.
- Três casos **não discriminam** (o fluxo legítimo e a não-alteração de `REJEITADO` humano passam nas duas versões). Estão lá para garantir que o legítimo continua funcionando.
- Casos marcados **SKIP** exigem Postgres real e não contam como aprovados.

## 6. O que NÃO foi testado

- **Concorrência com duas sessões** em Postgres real. Roteiro:
  1. sessão A: `begin; select ... from acordos_titulos where id = X for update;`
  2. sessão B: chamar `prime_liquidacao_suspender(X, ...)`, deve ficar bloqueada;
  3. sessão A: alterar a decisão humana para `REJEITADO` e `commit`;
  4. sessão B: deve devolver `DECISAO_HUMANA_PRESERVADA`.
- **Chamadores reais** (`prime_liquidacao_classificar_novas`), que dependem de dados e de contexto de sessão.
- **RLS, grants e roles reais** por perfil.

## 7. Rollback

- Parte 1: `supabase/aguardando_aprovacao/20261112230000_prime_protege_decisao_humana.rollback.sql`, executável, com as definições anteriores.
- Parte 2: `supabase/aguardando_aprovacao/20261112230000_prime_protege_decisao_humana.rollback_acl.sql`, que restaura o `EXECUTE` apenas para `service_role`.

Ordem: parte 1, depois parte 2. Não há dado a desfazer. **Reverter não restaura decisões já sobrescritas.**

## 8. Evidências reproduzíveis (somente leitura, agregadas)

Arquivo: `supabase/tests/prime_protecao/auditoria_leitura.sql`.

Retorna apenas contagens e somas. Não retorna identificadores.

## 9. Efeito sobre a conciliação

- Títulos sem decisão humana: nenhuma mudança.
- Títulos com decisão humana: a rotina deixa de reabrir ou reclassificar. Pretendido, mas altera o comportamento de `REJEITADO` com nova data de liquidação. **Decisão da conciliação necessária.**

## 10. Histórico Git

Identificadores e valores individualizados apareceram em commit anterior desta branch (ainda não mesclada). **Estratégia:** remover do conteúdo atual (este commit). Reescrever o histórico da branch só com autorização explícita, e apenas porque a branch não foi mesclada. Nada é reescrito automaticamente.

## 11. Riscos residuais

- Sobrescritas anteriores não registradas, quando a situação já era `EM_CONFIRMACAO`.
- Os títulos já perdidos não recuperam autor nem data sem decisão da gestão.
- Concorrência não comprovada em banco real.
- Chamadores reais não testados.
- Índice de auditoria `(registro_id, acao, created_at)` não verificado.

## 12. Pendências

1. Parecer do Guardião sobre esta versão.
2. Decisão da conciliação sobre a seção 9.
3. Roteiro de concorrência em Postgres isolado (exige instalação de Postgres, decisão sua).
4. Autorização para reescrever o histórico da branch, se a gestão optar por isso.
5. Restauração individual dos títulos afetados, com aprovação específica.
