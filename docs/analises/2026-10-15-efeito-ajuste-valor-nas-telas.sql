-- =============================================================================
-- EFEITO DO AJUSTE DE VALOR COBRÁVEL NAS 4 TELAS DE SALDO — PR #676
--
-- SOMENTE LEITURA. Nenhum statement aqui escreve, cria ou altera objeto.
-- Rodar no SQL Editor do Supabase (projeto da produção) e me devolver a saída.
--
-- O QUE ESTA MEDIÇÃO RESPONDE
--   Desde a migration 20260914100000, TODO leitor de backend faz
--   `coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, ...)`, inclusive a
--   RPC `aluno_saldo_pendente_detalhe` do card "Valor em aberto" da ficha.
--   As telas que somam título a título NO CLIENTE não aplicavam o ajuste e nem
--   pediam a coluna no `select`: `Aluno.jsx`, `PainelCarteira.jsx`, `CRM.jsx` e
--   `FilaOperacional.jsx`. O PR #676 corrige isso. Estas queries medem quanto
--   o número exibido ao operador muda ao mesclar.
--
-- POR QUE É CONDIÇÃO PARA MESCLAR: o PR altera valor EXIBIDO na operação. As
-- sessões de Claude perderam `execute_sql` no meio do dia 15/10/2026 ("You do
-- not have permission to perform this action" até em `select 1`, com o conector
-- listado como connected — é credencial da sessão, não query), então ninguém
-- mediu antes de abrir o PR. Está dito no corpo dele.
--
-- NADA AQUI TOCA REGRA DE SALDO, FIDELIZAÇÃO OU EFEITO FINANCEIRO.
--
-- NOTA DE PRECISÃO 1 — `CASE` e não `coalesce`: o frontend decide por
-- `temAjusteValor()`, que exige `valor_cobranca_ajustado > 0`. Um ajuste
-- gravado como 0 é IGNORADO pela tela, enquanto `coalesce` o escolheria.
-- Medir com coalesce SUPERESTIMA o efeito.
--
-- NOTA DE PRECISÃO 2 — uma base por tela: as telas divergem na ordem da
-- regra-base e o PR #676 deixou essa ordem INTOCADA de propósito (unificar
-- muda número e é decisão da gestão). `Aluno.jsx/valorTitulo` começa por
-- `saldo_corrigido`; a lista do `Aluno.jsx`, o `PainelCarteira` e o `CRM`
-- começam por `valor_em_aberto`; a `FilaOperacional` NÃO LÊ `valor_em_aberto`.
-- Medir as quatro com uma fórmula só dá número errado em três.
--
-- LIMITE — O DELTA É TETO, NÃO VALOR EXATO: o filtro de status/situação é o da
-- tela, mas o recorte de QUAIS ALUNOS cada tela carrega (a carteira do
-- operador, a fila do dia, a ficha aberta) não cabe em SQL de universo. Leia
-- como "no máximo isto".
-- =============================================================================
with t as (
  select
    (valor_cobranca_ajustado is not null and valor_cobranca_ajustado > 0) as tem_aj,
    valor_cobranca_ajustado                                       as aj,
    coalesce(saldo_corrigido, valor_em_aberto, valor_original, 0)  as base_saldo_primeiro,
    coalesce(valor_em_aberto, saldo_corrigido, valor_original, 0)  as base_aberto_primeiro,
    coalesce(saldo_corrigido, valor_original, 0)                   as base_fila,
    status, situacao, acordo_id, aluno_id, cpf
  from acordos_titulos
)
select * from (
  -- 0) O universo: existe ajuste gravado na base?
  select '0. universo: títulos com ajuste > 0' as tela,
         count(*) filter (where tem_aj)                                        as titulos,
         count(distinct aluno_id) filter (where tem_aj)                         as alunos,
         round(sum(case when tem_aj then aj - base_saldo_primeiro else 0 end), 2) as delta_rs
  from t

  union all
  -- 1) Aluno.jsx, valorTitulo(): base saldo_corrigido primeiro.
  select '1. Aluno.jsx ficha (valorTitulo)',
         count(*) filter (where tem_aj),
         count(distinct aluno_id) filter (where tem_aj),
         round(sum(case when tem_aj then aj - base_saldo_primeiro else 0 end), 2)
  from t

  union all
  -- 2) Aluno.jsx, enriquecimento da lista: status em_aberto/vinculada,
  --    base valor_em_aberto primeiro.
  select '2. Aluno.jsx lista (em_aberto+vinculada)',
         count(*) filter (where tem_aj),
         count(distinct aluno_id) filter (where tem_aj),
         round(sum(case when tem_aj then aj - base_aberto_primeiro else 0 end), 2)
  from t where status in ('em_aberto','vinculada')

  union all
  -- 3) PainelCarteira.jsx, consolidarFinanceiro(): mesmo filtro e mesma base.
  select '3. PainelCarteira (em_aberto+vinculada)',
         count(*) filter (where tem_aj),
         count(distinct aluno_id) filter (where tem_aj),
         round(sum(case when tem_aj then aj - base_aberto_primeiro else 0 end), 2)
  from t where status in ('em_aberto','vinculada')

  union all
  -- 4) CRM.jsx: só status = em_aberto, base valor_em_aberto primeiro.
  select '4. CRM.jsx (status=em_aberto)',
         count(*) filter (where tem_aj),
         count(distinct aluno_id) filter (where tem_aj),
         round(sum(case when tem_aj then aj - base_aberto_primeiro else 0 end), 2)
  from t where status = 'em_aberto'

  union all
  -- 5) FilaOperacional.jsx: descarta situacao PAGO e status quitada,
  --    base saldo_corrigido ?? valor_original (NÃO lê valor_em_aberto).
  select '5. FilaOperacional (sem PAGO/quitada)',
         count(*) filter (where tem_aj),
         count(distinct cpf) filter (where tem_aj),
         round(sum(case when tem_aj then aj - base_fila else 0 end), 2)
  from t
  where coalesce(situacao,'') <> 'PAGO' and lower(coalesce(status,'')) <> 'quitada'
) x order by tela;

-- COMO LER O SINAL: delta_rs POSITIVO = a tela mostrava MENOS do que o ajuste
-- manda cobrar (a tela subirá ao mesclar). NEGATIVO = mostrava MAIS (vai cair).
-- ZERO títulos na linha 0 = o PR fecha o buraco sem mudar número nenhum hoje,
-- e segue valendo a pena: o próximo ajuste que a gestão gravar já chega à tela.
