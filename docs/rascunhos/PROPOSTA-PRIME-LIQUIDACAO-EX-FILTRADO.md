# Proposta — otimização da seleção de `prime_liquidacao_classificar_novas`

**Status:** proposta para revisão. **Nada foi aplicado em produção.** Não há migration nesta PR.

**Escopo:** só a seleção de candidatos da liquidação (CTE `ex`). Não altera critérios de elegibilidade, decisões manuais nem o efeito de `prime_liquidacao_suspender` / `prime_liquidacao_reavaliar_pendentes`.

---

## 1. A mudança proposta

Na CTE `ex` da função, o `DISTINCT ON` lê **todo** `prime_extrato` com `liquidado_em` preenchido (419.572 linhas hoje). Só depois o resultado é cruzado com os títulos em cobrança.

A proposta é restringir o `ex` aos boletos que pertencem a títulos em cobrança **antes** do `DISTINCT ON`:

```sql
ex as (
  select distinct on (ltrim(e.boleto,'0')) ltrim(e.boleto,'0') as boleto, e.liquidado_em, e.portador, e.valor_bruto, e.valor_pago,
         e.coletado_em
    from public.prime_extrato e
   where e.liquidado_em is not null
     and ltrim(e.boleto,'0') in (
           select ltrim(coalesce(t.documento,''),'0')
             from public.acordos_titulos t
            where coalesce(t.tipo_boleto,'') <> 'Acordo'
              and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
              and coalesce(lower(t.status),'') <> 'quitada')
   order by ltrim(e.boleto,'0'), e.coletado_em desc
)
```

Todo o resto da função permanece **idêntico**.

## 2. Por que é equivalente

- O `DISTINCT ON` escolhe **uma linha por boleto**, usando só as linhas daquele boleto. Restringir o conjunto de boletos não altera a linha escolhida para nenhum boleto que sobreviva ao filtro.
- A junção final é um `inner join` em `ex.boleto = ltrim(coalesce(c.documento,''),'0')`, e o subconjunto usado no filtro é exatamente o conjunto de documentos dos títulos em `cob`. Portanto, nenhum boleto que contribuiria para o resultado final é descartado.
- Os predicados de elegibilidade (`portador = 195`, datas, guardas, `NOT EXISTS`) continuam aplicados depois, sobre o mesmo conjunto.

**Caso especial:** documento nulo ou vazio vira `''` nos dois lados, e continua casando do mesmo jeito.

## 3. Testes de equivalência (PGlite, dados fictícios)

Script: `supabase/tests/liquidacao_selecao/equivalencia.mjs`. Roda em Node com `@electric-sql/pglite`, sem Docker e sem serviço. **Não conecta em produção.**

Dados sintéticos: 1.500 títulos, 3.552 linhas de extrato com várias coletas por boleto, documentos com zeros à esquerda, decisões humanas (`PENDENTE`, `REJEITADO`, `VINCULADO`, `CONFIRMADO`, `ENCERRADO_ADMINISTRATIVO`, `DEVOLVIDO`) e classificações prévias (`ROTINA`, `CORTE`, `MANUAL`).

| Limite | Candidatos (atual) | Candidatos (proposta) | IDs, ordem, valores e chave iguais |
|---|---|---|---|
| 500 | 112 | 112 | **sim** |
| 50 | 50 | 50 | **sim** |
| 7 | 7 | 7 | **sim** |

Linhas de extrato lidas pelo `DISTINCT ON`: **2.978 → 1.027** (redução de 66%). Essa é a contagem de linhas que entram na agregação, e não tempo de execução.

## 4. O que os testes **não** cobrem

- Não executam `prime_liquidacao_suspender` nem `prime_liquidacao_reavaliar_pendentes`. Essas funções não mudam, então não são afetadas por esta proposta.
- Não validam o plano de execução real em produção. O ganho de tempo é **estimado** a partir do número de linhas, e não medido.
- Não validam RLS, porque o teste é executado sem políticas.

## 5. Plano de execução estimado (não executado)

- **Plano atual:** `Index Scan` sobre `ix_prime_extrato_boleto_ltrim` com 419 mil linhas, seguido de `Incremental Sort` e `Unique`. Custo estimado do `EXPLAIN`: **~41 mil**.
- **Plano proposto:** o mesmo índice, agora com acesso por boleto a partir do conjunto de títulos em cobrança. O índice já existe e casa com a expressão `ltrim(boleto, '0')`.
- **Ganho:** **estimado**. Confirmar com `EXPLAIN` (sem `ANALYZE`) em janela autorizada, comparando as duas formas.

## 6. Riscos

| Risco | Gravidade | Mitigação |
|---|---|---|
| Diferença de equivalência não coberta pelos dados sintéticos | média | ampliar o teste com dados reais anonimizados, em ambiente isolado, antes da aplicação |
| O planejador escolher um plano pior | baixa | comparar `EXPLAIN` antes e depois; manter a versão atual pronta para reversão |
| Alteração de função financeira | alta | exige revisão de quem cuida da conciliação e janela fora do expediente |

## 7. Rollback

1. Reaplicar a definição atual da função, guardada antes da alteração com `pg_get_functiondef`.
2. Nenhum dado é alterado pela proposta. Não há migration de dados.
3. Como a mudança é só na seleção, reverter é reescrever a função para a versão anterior. Procedimento de backup e restauração por `CREATE OR REPLACE`, conforme a regra de grants do projeto: conferir grants e `search_path` depois.

---

## 8. Auditoria de segurança financeira (achado independente, não corrigido nesta PR)

**Achado:** `prime_liquidacao_suspender` faz `INSERT ... ON CONFLICT (titulo_id) DO UPDATE` em `prime_conferencia_decisao` **sem condição sobre a decisão anterior**. Ele reescreve `decisao = 'PENDENTE'`, limpa `decidido_por` e `decidido_em`.

Hoje, `prime_conferencia_decisao` tem decisões humanas: `VINCULADO` (431), `ENCERRADO_ADMINISTRATIVO` (375), `REJEITADO` (329), `CONFIRMADO` (36), `DEVOLVIDO` (18).

A função é chamada só para as rotas A (pagamento comprovado) e B (acordo comprovado). A seleção exclui títulos com decisão `PENDENTE` e `REJEITADO` **de mesma data de liquidação**. Não exclui as demais decisões.

**Exposição medida (leitura):** 249 títulos com decisão `REJEITADO` e 84 com `VINCULADO`, ainda em cobrança e com liquidação do portador 195. Para `REJEITADO`, a exclusão só vale se a data de liquidação for a mesma. Se a Prime tiver outra data, o título volta a ser candidato.

**Não verifiquei** se algum desses títulos já foi sobrescrito. A verificação exige cruzar a auditoria com o histórico de decisões, e isso não foi feito.

**Recomendação (não incluída nesta PR):** restringir o `ON CONFLICT` para só atualizar linhas com `decisao = 'PENDENTE'`, ou excluir da seleção qualquer título com decisão diferente de `PENDENTE`. Mudança de comportamento financeiro: precisa de decisão de quem cuida da conciliação.

**Efeito de `prime_liquidacao_reavaliar_pendentes`:** atualiza apenas linhas `PENDENTE` com subgrupo `C_SEM_PROVA`, `B_ACORDO_COMPROVADO` ou `A_PAGAMENTO_COMPROVADO`. Reverte para `ABERTO` títulos `EM_CONFIRMACAO` cuja liquidação sumiu da Prime, marcando a decisão como `REJEITADO`. Essa parte não tem o problema de sobrescrita, mas altera situação de título, então também precisa de revisão.

---

## 9. Proposta de índice sobre CPF normalizado (não criado)

**Objetivo:** permitir que o filtro de CPF normalizado em `prime_contratos` use índice.

```sql
-- NÃO EXECUTAR SEM AUTORIZAÇÃO. DDL.
create index concurrently ix_prime_contratos_cpf11
  on public.prime_contratos ((lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0')));
```

**Evidência de plano (EXPLAIN sem ANALYZE):**

- Com a expressão: `Index Only Scan` na chave primária inteira, com filtro na expressão. Custo estimado **2.236**.
- Sem a expressão, usando `cpf` bruto: `Index Cond`, custo **4,76**.
- **Para o índice proposto, o ganho ainda é estimado.** O plano só muda depois de criado ou simulado com `hypopg`.

**Dados:** 68.092 linhas. Todos os CPFs já têm 11 dígitos e nenhum é nulo. A expressão é idempotente hoje.

**Custo de armazenamento:** o índice atual de `prime_contratos` ocupa 9,3 MB no total, com a chave primária em 4,5 MB. Um índice sobre uma expressão de 11 caracteres deve ficar na faixa de **2 a 3 MB**. **Estimado.**

**Custo nas gravações:** cada `INSERT` ou `UPDATE` em `prime_contratos` atualiza mais um índice. Como a tabela é alimentada pela coleta da Prime, o custo é pequeno e proporcional ao volume de importação. **Estimado, não medido.**

**Alternativa sem índice:** trocar o filtro por `cpf = any(...)`, equivalente hoje porque todos os CPFs já estão normalizados, mas que deixaria de ser equivalente se um CPF sem formatação entrasse no futuro. Não recomendo sem uma garantia de normalização na escrita.

---

## 10. Pendências para aprovação

1. Revisão de quem cuida da conciliação sobre a seção 8.
2. Autorização para `EXPLAIN` comparativo, ou para simular o índice com `hypopg`.
3. Decisão sobre aplicar ou não a seção 9.
4. Só depois, a migration de substituição da função, com rollback e janela fora do expediente.
