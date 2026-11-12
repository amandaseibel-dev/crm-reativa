# Proposta — proteção de decisões humanas na liquidação Prime

**Status:** PR de correção, pendente de aprovação e de parecer do Guardião. **Não aplicada em produção.** Não há merge nem deploy.

**Independente da #942.** Não mistura a otimização da seleção (CTE `ex`).

---

## 1. Problema comprovado

`prime_liquidacao_suspender` fazia `INSERT ... ON CONFLICT (titulo_id) DO UPDATE` **sem condição sobre a decisão anterior**. Qualquer decisão humana podia voltar a `PENDENTE` com `decidido_por` e `decidido_em` apagados.

**Comprovado (auditoria):** 10 títulos, R$ 2.389,14, 3 alunos. Cada um tem ação humana `CONFERENCIA_PRIME_VINCULO` em 18/09/2026 17:57:39 UTC, suspensão automática em 26/09/2026 (03:50 e 04:50 UTC), e hoje estão em `EM_CONFIRMACAO`, com `PENDENTE` e sem autor.

## 2. O que a correção muda

Arquivo: `supabase/aguardando_aprovacao/20261112230000_prime_protege_decisao_humana.sql.pendente`

**`prime_liquidacao_suspender`**
- Trava a linha da decisão (`FOR UPDATE`) antes de decidir.
- Se a decisão existente não é `PENDENTE` **ou** tem `decidido_por`:
  - não sobrescreve a decisão;
  - não muda a situação do título;
  - não grava movimentação;
  - registra `PRIME_SUSPENSAO_BLOQUEADA_DECISAO_HUMANA` em `auditoria`, **no máximo uma vez por título por dia**;
  - devolve `{ok: false, bloqueado: 'DECISAO_HUMANA_PRESERVADA'}`.
- Decisão `PENDENTE` sem `decidido_por` (criada pela própria rotina) segue o fluxo normal.

**`prime_liquidacao_reavaliar_pendentes`**
- Só reavalia linhas `PENDENTE` **sem** `decidido_por`.
- Conta em `ignoradas_decisao_humana` as linhas deixadas de fora.

## 3. O que não muda

- Critérios de elegibilidade (`prime_liquidacao_classificar_novas` não é alterada).
- Rotas A e B para títulos **sem** decisão humana.
- Nenhuma tabela ou linha é alterada pela migration.

## 4. Testes

Arquivo: `supabase/tests/prime_protecao/protecao.test.mjs`. Roda em PGlite (Postgres embutido), sem Docker e sem produção. **Carrega o arquivo da migration real**, não uma cópia. Sai com código 1 se houver qualquer falha.

**Resultado:** 13 de 13 passando.

Casos cobertos:
- fluxo legítimo: título sem decisão vai para `EM_CONFIRMACAO`; PENDENTE da rotina pode ser reprocessada; situação `NEGOCIADO` continua recusada;
- decisões humanas `VINCULADO`, `REJEITADO`, `ENCERRADO_ADMINISTRATIVO`, `CONFIRMADO`, `DEVOLVIDO`: decisão, autor, data e situação preservados, auditoria registrada;
- `PENDENTE` **com** `decidido_por` tratada como humana;
- tentativas repetidas no mesmo dia geram uma linha de auditoria por título;
- reavaliação reverte PENDENTE da rotina;
- reavaliação não reabre título com decisão humana e não altera `REJEITADO` humano.

**Controles negativos (provam que os testes pegam o problema):**
- sem a guarda do `suspender`: 7 falhas, todas nos casos de decisão humana;
- sem o filtro da reavaliação também: 8 falhas, incluindo a de reabertura indevida.

## 5. Concorrência

`suspender` trava o título (`FOR UPDATE` em `acordos_titulos`) e a decisão (`FOR UPDATE` em `prime_conferencia_decisao`) antes de decidir. Uma decisão humana concorrente espera o commit da rotina e, quando a rotina roda, já vê a decisão humana.

**Não testado em concorrência real.** PGlite é um processo único. Roteiro manual, em Postgres isolado com duas sessões:
1. sessão A: `begin; select ... from prime_conferencia_decisao where titulo_id = X for update;`
2. sessão B: chamar `prime_liquidacao_suspender(X, ...)`; deve ficar bloqueada;
3. sessão A: alterar a decisão para `REJEITADO` e `commit`;
4. sessão B: deve devolver `DECISAO_HUMANA_PRESERVADA`.

## 6. Efeito sobre a conciliação legítima

- Títulos sem decisão humana: nenhuma mudança.
- Títulos com decisão humana: a rotina **deixa de** reabrir ou reclassificar. Isso é o pretendido, mas **altera o comportamento** para títulos `REJEITADO` com nova data de liquidação na Prime, que antes eram reavaliados. Essa mudança precisa de decisão da conciliação.

## 7. Auditoria dos títulos reabertos (186 → 339)

Os títulos devolvidos à cobrança pela reavaliação (`TITULO_CONFIRMACAO_REJEITADA`) somam **339 títulos distintos**:

| Classe | Títulos | Em cobrança hoje | Valor em cobrança | Com movimentação humana depois |
|---|---|---|---|---|
| Suspeito: decisão humana antes, sem ação humana depois | 183 | 141 | R$ 543.226,57 | 112 |
| Sem evidência humana | 153 | 109 | R$ 304.342,42 | 100 |
| Com nova ação humana depois | 3 | 0 | — | 0 |

**Leitura correta dessa tabela:**
- "Suspeito" **não é comprovado**. A reversão só acontece com decisão `PENDENTE`, o que indica sobrescrita anterior, mas a suspensão só grava movimentação quando a situação muda, então o rastro é incompleto.
- "Movimentação humana" é um critério aproximado: qualquer registro que não seja de tipo `TITULO_` ou `REABERTURA`. Pode incluir ações automáticas.
- Os 141 títulos suspeitos em cobrança precisam de **verificação individual** pela conciliação antes de qualquer ação. Não há restauração automática.

## 8. Plano de recuperação dos 10 títulos comprovados

**Não executado.** Restaurar registro financeiro exige aprovação específica da gestão.

| titulo_id | documento | valor | decisão humana anterior |
|---|---|---|---|
| d49a9c35-32d7-43f7-a474-f528adce70dd | 3561539 | 233,15 | VINCULADO (18/09/2026 17:57 UTC) |
| d9bcab80-208d-4501-a2f1-920fc2492b91 | 3561540 | 233,15 | VINCULADO |
| 2c68957f-3326-4f1c-b91b-23d5f8779e13 | 3561541 | 233,15 | VINCULADO |
| d414ba9c-2096-42a9-b706-1f94e748a162 | 3561542 | 233,14 | VINCULADO |
| 86748541-d010-4f18-94b1-4bd2480f0d90 | 4308334 | 284,20 | VINCULADO |
| 8349b640-3e1b-413e-aa5b-5a59ba1c6461 | 4308335 | 284,21 | VINCULADO |
| ada29e2d-3764-4491-aaa8-6b896e54e494 | 907513 | 253,75 | VINCULADO |
| 0fef183f-0d77-47b3-96c5-e985e89d43ae | 907514 | 253,75 | VINCULADO |
| a0d34ef1-7a72-4e20-8fa3-32b41a4db71b | 907515 | 253,75 | VINCULADO |
| 5d565141-bc12-448a-9545-b2db4e56243c | 907516 | 126,89 | VINCULADO |

**Estado comum:** `EM_CONFIRMACAO`, `PENDENTE`, sem `decidido_por`, sem `decidido_em`, sem `acordo_id`.

**Para cada título, a gestão precisa decidir:**
1. **Confirmar na Prime** que a liquidação ainda existe (evidência atual).
2. **Qual decisão restaurar.** O registro original era `VINCULADO`, mas o vínculo depende de um acordo, e o `acordo_id` foi perdido. Pode ser preciso reconstituir o acordo antes de restaurar.
3. **Qual situação o título deve ter.** A suspensão tirou o título da cobrança; devolver à cobrança ou manter fora é decisão da conciliação.
4. **Quem é o autor a registrar.** A auditoria mostra a ação humana original, mas quem restaura deve ser identificado no próprio registro.

**Procedimento (quando aprovado):** um título por vez, com `begin`, `select ... for update`, conferência do estado antes e depois, e registro de auditoria da restauração. Nunca em lote automático.

## 9. Riscos residuais

- **Sobrescritas não registradas:** a suspensão não grava auditoria quando a situação já era `EM_CONFIRMACAO`. Títulos sobrescritos nessa condição não aparecem no rastro. O número real pode ser maior que 10.
- **Os 10 já perdidos:** a correção impede novas perdas, mas não recupera as três informações apagadas (autor, data e decisão exata). Recuperação depende de decisão da gestão.
- **Mudança de comportamento** para `REJEITADO` com nova data de liquidação (seção 6).
- **Carga de auditoria:** limitada a uma linha por título por dia, mas sem índice explícito em `auditoria(registro_id, acao, created_at)`. Recomendado verificar o plano antes da aplicação.
- **Concorrência não testada em banco real** (seção 5).
- **Não validado:** RLS, grants reais e o estado da versão da função em produção.

## 10. Rollback

Arquivo: `supabase/aguardando_aprovacao/20261112230000_prime_protege_decisao_humana.rollback.sql`.

Reverter é reaplicar as duas definições anteriores de `supabase/migrations/20260918230000_prime_liquidacao_regra_entrada.sql`. Não há dado a desfazer. Reverter **não restaura** decisões sobrescritas.

## 11. Pendências para aprovação

1. Parecer do Guardião sobre esta PR.
2. Decisão da conciliação sobre a mudança de comportamento da seção 6.
3. Roteiro de concorrência executado em Postgres isolado.
4. Verificação do plano de execução da consulta de auditoria.
5. Autorização para a restauração individual dos 10 títulos (seção 8).
6. Verificação título a título dos 141 suspeitos em cobrança.
