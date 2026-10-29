-- A tela do Financeiro chamava de "em aberto" TUDO que nao estava marcado PAGO.
--
-- CASO QUE ABRIU: Frederico Tarrago Mattos Scheffer (CPF 032.689.200-12). A tela
-- mostrava R$ 78.630,55 em aberto e proximo vencimento 05/02/2026 -- uma data que
-- a gestao nao conseguia referenciar em lugar nenhum. Os 5 titulos estao
-- NEGOCIADO e TODOS vinculados ao acordo 3590; 05/02/2026 e o vencimento da
-- mensalidade ORIGINAL, de antes da negociacao, que perdeu o sentido no instante
-- em que virou acordo. A divida real dele e o acordo: R$ 67.820,60 em aberto,
-- proxima parcela 28/08/2026. O saldo canonico do aluno ja estava correto -- so
-- esta view errava.
--
-- O QUE ENTRAVA INDEVIDAMENTE (medido em 28/08/2026):
--   NEGOCIADO   2.718 titulos  R$ 5.852.591,76  (2.716 vinculados a acordo)
--   DUPLICADA     210 titulos  R$   181.017,44
--
-- Efeito: 562 alunos apareciam devendo mais do que devem, R$ 1.354.232,30 a
-- mais; 27 apareciam com divida tendo saldo ZERO. Depois: 11 alunos e
-- R$ 49.495,46 -- residuo de outra origem (saldo_corrigido x saldo canonico),
-- nao causado por esta view.
--
-- A REGRA E A PREMISSA 1, dita pela Amanda: "quando vira acordo as mensalidades
-- zeram e vale apenas o acordo, o saldo em aberto". Contar NEGOCIADO como aberto
-- e dupla contagem por outro caminho -- soma a parcela do acordo E a mensalidade
-- que ele substituiu.
--
-- MAS ZERAR NAO PODE VIRAR "PAGO". A primeira versao deste conserto deixou o
-- Frederico rotulado PAGO, o que contraria a premissa 3 ("Pago" so com saldo
-- zerado) -- ele nao pagou, negociou, e ainda deve R$ 67.820,60. Por isso existe
-- o rotulo proprio NEGOCIADO.
--
-- E ZERAR A MENSALIDADE NAO PODE ESCONDER A DIVIDA. Mostrar "0 em aberto" para
-- quem deve R$ 67 mil trocaria um erro por outro. A view passa a expor tambem o
-- lado do acordo -- parcelas abertas, valor e proxima parcela -- mais o
-- `saldo_total` canonico de `alunos`, que e a fonte unica do saldo.
--
-- `situacao = 'ABERTO'` e o filtro certo, e nao "acordo_id is null": os 40.916
-- ABERTO tem zero vinculados, entao hoje os dois criterios concordam -- mas
-- ABERTO e o estado declarado e o vinculo e consequencia dele.
--
-- COLUNAS NOVAS VAO NO FIM: `create or replace view` nao deixa renomear nem
-- reordenar coluna existente.
--
-- Custo: 242 ms no plano completo (13.880 alunos), com Memoize no lateral. A
-- tela pagina, entao na pratica le muito menos.

create or replace view public.consulta_financeira_por_aluno as
select
  a.id as aluno_id,
  a.nome,
  a.cpf,
  a.responsavel_atual_email,
  a.responsavel_atual_nome,
  count(t.id) as qtd_titulos,
  count(t.id) filter (where t.situacao = 'ABERTO') as qtd_em_aberto,
  count(t.id) filter (where t.situacao = 'PAGO') as qtd_pagos,
  coalesce(sum(t.saldo_corrigido) filter (where t.situacao = 'ABERTO'), 0::numeric) as valor_em_aberto,
  min(t.vencimento) filter (where t.situacao = 'ABERTO') as proximo_vencimento,
  count(t.id) filter (where t.situacao = 'ABERTO' and t.vencimento < current_date) > 0 as tem_atraso,
  case
    when count(t.id) filter (where t.situacao = 'ABERTO') > 0
         and count(t.id) filter (where t.situacao in ('PAGO','NEGOCIADO')) > 0 then 'PARCIAL'
    when count(t.id) filter (where t.situacao = 'ABERTO') > 0 then 'EM_ABERTO'
    when count(t.id) filter (where t.situacao = 'NEGOCIADO') > 0 then 'NEGOCIADO'
    when count(t.id) filter (where t.situacao = 'PAGO') > 0 then 'PAGO'
    else 'SEM_TITULO'
  end as situacao_geral,
  count(t.id) filter (where t.situacao = 'NEGOCIADO') as qtd_negociados,
  coalesce(sum(t.saldo_corrigido) filter (where t.situacao = 'NEGOCIADO'), 0::numeric) as valor_negociado,
  ac.parcelas_abertas as qtd_parcelas_acordo,
  coalesce(ac.valor_acordo_aberto, 0::numeric) as valor_acordo_aberto,
  ac.proxima_parcela_acordo,
  round(coalesce(a.saldo_total, 0::numeric), 2) as saldo_total
from public.alunos a
join public.acordos_titulos t on t.cpf = a.cpf
left join lateral (
  select count(p.id)::int as parcelas_abertas,
         sum(p.valor) as valor_acordo_aberto,
         min(p.vencimento) as proxima_parcela_acordo
    from public.acordos ac2
    join public.parcelas p on p.acordo_id = ac2.id
   where ac2.aluno_id = a.id
     and upper(coalesce(ac2.status,'')) = 'ATIVO'
     and p.status <> 'PAGO'
) ac on true
group by a.id, a.nome, a.cpf, a.responsavel_atual_email, a.responsavel_atual_nome,
         ac.parcelas_abertas, ac.valor_acordo_aberto, ac.proxima_parcela_acordo, a.saldo_total;
