-- BACKFILL de aluno_movimentacoes.lote_id para os lotes historicos CONFIRMADOS.
-- NAO APLICAR sem autorizacao expressa. Depende de 20260920100000 (coluna lote_id).
--
-- Chave do vinculo (inequivoca, sem probabilidade):
--   movimentacao.tipo = tipo do canal do lote
--   movimentacao.aluno_id  IN lote.aluno_ids
--   movimentacao.registrado_em = lote.confirmado_em  (EXATO: registrar_acao_massiva
--                                                     e concluir_lote rodam na mesma
--                                                     transacao, now() identico)
-- So recebe lote_id a movimentacao que casa com EXATAMENTE UM lote e ainda esta
-- NULL. Ambiguidade (casaria com 2+ lotes) => fica NULL. Lote nao confirmado
-- (inclusive o aberto de 19/09, 97 alunos) NAO entra: exige confirmado_em.
--
-- SIMULACAO (leitura; rodada em producao em 20/09/2026):
--   6 lotes confirmados, 1.800 registrados segundo o resultado de cada lote
--   1.800 vinculos inequivocos, 0 ambiguos
--   por lote: casadas = registrados (94, 449, 41, 100, 117, 999)
--   4 alunos constam em aluno_ids e nao tem movimentacao (foram excluidos na
--   confirmacao: total 98 x registrados 94 no primeiro lote) -> ficam sem vinculo.

-- ---------- 1) SIMULACAO (so leitura) -------------------------------------
-- with l as (
--   select id, aluno_ids, confirmado_em,
--          case canal when 'WHATSAPP' then 'ACAO_MASSIVA_EXTERNA' else 'ACAO_MASSIVA_EXTERNA_EMAIL' end as tipo,
--          total, (resultado->>'registrados')::int as registrados
--     from public.acoes_massivas_lotes where confirmado_em is not null),
-- cand as (
--   select l.id as lote, m.ctid as mid
--     from l join public.aluno_movimentacoes m
--       on m.tipo = l.tipo and m.aluno_id = any(l.aluno_ids) and m.registrado_em = l.confirmado_em),
-- por_mov as (select mid, count(distinct lote) as n from cand group by mid)
-- select (select count(*) from l) as lotes,
--        (select sum(registrados) from l) as registrados,
--        (select count(*) from por_mov where n = 1) as inequivocos,
--        (select count(*) from por_mov where n > 1) as ambiguos,
--        (select sum(total - registrados) from l) as sem_movimentacao;

-- ---------- 2) BACKFILL ----------------------------------------------------
with l as (
  select id, aluno_ids, confirmado_em,
         case canal when 'WHATSAPP' then 'ACAO_MASSIVA_EXTERNA' else 'ACAO_MASSIVA_EXTERNA_EMAIL' end as tipo
    from public.acoes_massivas_lotes
   where confirmado_em is not null),
cand as (
  select l.id as lote, m.ctid as mid
    from l join public.aluno_movimentacoes m
      on m.tipo = l.tipo and m.aluno_id = any(l.aluno_ids) and m.registrado_em = l.confirmado_em
   where m.lote_id is null),
unico as (
  select mid, (array_agg(lote))[1] as lote
    from cand group by mid having count(distinct lote) = 1)
update public.aluno_movimentacoes m
   set lote_id = u.lote
  from unico u
 where m.ctid = u.mid and m.lote_id is null;
