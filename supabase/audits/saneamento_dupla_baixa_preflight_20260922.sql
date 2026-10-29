-- PREFLIGHT CONGELADO DO SANEAMENTO -- 22/09/2026, somente leitura.
-- Fonte dos IDs literais de 20260922300000_saneamento_dupla_baixa_historica.sql.
--
-- SNAPSHOT (22/09/2026 22:01 UTC, antes de qualquer escrita):
--   baixas total / vivas / devolvidas ....... 3.403 / 2.977 / 426
--   valor baixado vivo ...................... R$ 5.019.299,87
--   honorarios vivos ........................ R$    37.674,54
--   parcelas PAGO ........................... 4.944
--   audit_log_max_id ........................ 203266
--   aluno_movimentacoes ..................... 195.547
--   notificacoes ............................ 8.844
--   parcelas com 2 baixas vivas ............. 11  (maximo 2, nenhuma com 3)
--   excedente ............................... R$    17.069,30
--   honorarios na 2a baixa .................. R$       737,69
--
-- ESPERADO APOS O SANEAMENTO DOS 10:
--   parcelas com duplicidade ................ 11 -> 1  (so a da Maiara)
--   valor baixado vivo ...... 5.019.299,87 -> 5.002.865,03   (-16.434,84)
--   honorarios vivos ...........  37.674,54 ->   36.936,85   (-737,69)
--   parcelas PAGO / alunos / acordos ........ inalterados
--   notificacoes ............................ inalteradas (8.844)
--
-- OS 10 PARES CONGELADOS  (fica | devolver | parcela | valor | honorario da 2a)
--  Murilo Montemezzo      67f3e82a | 41fcfcd6 | f41f03d3 | 7.873,68 | 583,24
--  Pablo Juan Werlang     e967c28d | bd2fe50e | 42319df4 | 1.775,33 | 131,51
--  Bianca O. Michielin    7d3a56fd | f18fc685 | 2ad09a00 | 1.637,95 |   0,00
--  Enzo E. Alves Borges   69c30813 | b7b336d1 | 84f8349f | 1.288,30 |   0,00
--  Gabriel G. Oliveira p3 6f9009a7 | 9953927f | 4590c339 |   813,56 |   0,00
--  Gabriel G. Oliveira p2 7544fc96 | 3d9cf264 | 2e01f8a2 |   813,56 |   0,00
--  Gabriel G. Oliveira p4 a83d863c | 80832d6f | 15ea01b8 |   813,56 |   0,00
--  Lanna C. B. dos Santos 94bacbc9 | ec2fb7c7 | d1cc1b6a |   620,49 |   0,00
--  Bruna O. de O. Goulart ce426d07 | 4f84aff9 | c0f1d10f |   488,68 |   0,00
--  Bianca Florence Silva  935ed174 | c5a391ec | 365a7b42 |   309,73 |  22,94
--                                                  soma:  16.434,84 | 737,69
--
-- FORA: Maiara Ramos Machado, parcela e62006af-a61e-43eb-9729-367819c06e76,
-- R$ 634,46. 13 dias entre as baixas, nenhum pagamento registrado para nenhuma
-- delas, prime_extrato vazio. Classe D -- inconclusivo. Segue com 2 vivas.
--
-- EVIDENCIA EXTERNA: `prime_extrato` NAO tem uma unica linha para nenhum dos 11
-- boletos. A unica corroboracao disponivel e `pagamentos` (arquivo Santander),
-- presente em 5 dos 11 -- e em todos os 5 com EXATAMENTE UM recebimento.
--
-- Consulta que reproduz a lista (somente leitura):
with dup as (
  select parcela_id from public.baixas_pagamento
   where devolvido_em is null and parcela_id is not null
   group by 1 having count(*) > 1
), b as (
  select bb.*, row_number() over (partition by bb.parcela_id order by bb.baixado_em, bb.id) rn
    from public.baixas_pagamento bb join dup d on d.parcela_id = bb.parcela_id
   where bb.devolvido_em is null
)
select al.nome, ac.numero_acordo, pa.numero, pa.boleto, pa.valor,
       k.id as fica, x.id as devolver, coalesce(x.honorarios_recebidos,0) as hon_2a,
       round(extract(epoch from (x.baixado_em - k.baixado_em))::numeric,1) as intervalo_seg
  from dup d
  join public.parcelas pa on pa.id = d.parcela_id
  join public.acordos ac on ac.id = pa.acordo_id
  left join public.alunos al on al.id = ac.aluno_id
  join b k on k.parcela_id = pa.id and k.rn = 1
  join b x on x.parcela_id = pa.id and x.rn = 2
 order by pa.valor desc;
