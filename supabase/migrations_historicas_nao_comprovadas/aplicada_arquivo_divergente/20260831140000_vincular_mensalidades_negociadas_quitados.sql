-- Mensalidades negociadas ficaram soltas: o aluno quitou e seguia devendo.
--
-- Amanda, 31/08: "o que eu quitei continua como em aberto". Depois de olhar os
-- casos: "as mensalidades todas foram negociadas".
--
-- O PADRAO, identico nos cinco: negociou -> acordo -> pagou TODAS as parcelas ->
-- caso quitado. Mas as mensalidades que viraram aquele acordo nunca foram
-- marcadas nem ligadas a ele. Como mensalidade so sai da conta se estiver
-- VINCULADA, elas seguiram ABERTO -- e o aluno continuou devendo na tela depois
-- de ter pago tudo.
--
--   aluno                     acordo   status    parcelas pagas   soltas    valor
--   Jamily Saraiva Lopes      20/07    QUITADO        5 de 5         3   3.076,34
--   Thalyssa H. R. de Melo    20/07    QUITADO        3 de 3         4   2.603,71
--   Thalysson E. R. de Melo   20/07    QUITADO        3 de 3         4   2.713,07
--   Douglas Tavares da Silva  07/08    ATIVO          1 de 1         4   1.790,29
--   Yara Vitoria Rosa         07/08    ATIVO          1 de 1         1   1.030,40
--                                                                 ----  ---------
--                                                                   16  11.213,81
--
-- Cada um tem UM acordo so -- nao ha ambiguidade sobre onde ligar.
--
-- ISTO NAO APAGA DIVIDA. Registra que a divida virou acordo e o acordo foi pago.
-- O valor segue visivel na ficha, no bloco "Mensalidades negociadas neste
-- acordo" -- so deixa de ser cobrado duas vezes.
--
-- O VINCULO EXIGE QUATRO COISAS, e errar uma nao faz nada acontecer. Descoberto
-- na marra: marcar so `situacao` e `acordo_id` nao mexeu no saldo. Os 2.733
-- titulos negociados corretamente tem TODAS:
--   1. acordos_titulos.situacao  = 'NEGOCIADO'
--   2. acordos_titulos.status    = 'vinculada'
--   3. acordos_titulos.acordo_id = o acordo
--   4. uma linha ativa em `acordo_titulo_vinculo`
-- E a (4) que `recalcular_situacao_aluno` consulta para tirar a mensalidade da
-- conta. Sem ela, o saldo nao muda por mais que os outros tres estejam certos.
--
-- POR QUE SO ESTES CINCO: sao os casos em que a prova fecha -- caso quitado,
-- acordo unico, parcelas todas pagas. Existem 2.069 acordos ATIVOS sem nenhuma
-- mensalidade vinculada; aquilo e outro problema, maior, e nao se resolve por
-- deducao como este.
--
-- DEPOIS DE APLICAR (recalculo por aluno): os cinco foram para saldo R$ 0,00.
-- Quatro viraram QUITADO; a Yara foi para AGUARDANDO_CONFIRMACAO, que e uma
-- pendencia dela em outro fluxo, nao resto de divida.
--
-- DESFAZER: supabase/rollbacks/20260831140000_vincular_mensalidades_negociadas_quitados.rollback.sql

create table if not exists public._backup_vinculo_negociadas_20260831 as
select t.*, now() as backup_em
  from public.acordos_titulos t
 where upper(coalesce(t.situacao,'')) = 'ABERTO'
   and t.aluno_id in (
     select al.id from public.alunos al
      where al.nome in ('Jamily Saraiva Lopes','Thalysson Eliote Ribeiro de Melo',
                        'Thalyssa Halley Ribeiro de Melo','Douglas Tavares da Silva','Yara Vitória Rosa')
        and exists (select 1 from public.casos c where c.aluno_id = al.id and c.quitado_em is not null)
        and (select count(*) from public.acordos a where a.aluno_id = al.id) = 1
   );

alter table public._backup_vinculo_negociadas_20260831 enable row level security;

update public.acordos_titulos t
   set acordo_id      = a.id,
       situacao       = 'NEGOCIADO',
       status         = 'vinculada',
       vinculado_em   = now(),
       vinculado_por  = 'correcao 31/08: acordo pago, mensalidade seguia aberta',
       motivo_ajuste  = coalesce(t.motivo_ajuste,'')
                        || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
                        || 'vinculada ao acordo em 31/08/2026 -- negociada e paga via acordo',
       atualizado_em  = now()
  from public.alunos al
  join public.acordos a on a.aluno_id = al.id
 where t.aluno_id = al.id
   and upper(coalesce(t.situacao,'')) = 'ABERTO'
   and al.nome in ('Jamily Saraiva Lopes','Thalysson Eliote Ribeiro de Melo',
                   'Thalyssa Halley Ribeiro de Melo','Douglas Tavares da Silva','Yara Vitória Rosa')
   and exists (select 1 from public.casos c where c.aluno_id = al.id and c.quitado_em is not null)
   and (select count(*) from public.acordos a2 where a2.aluno_id = al.id) = 1;

-- A peca que efetivamente tira do saldo.
insert into public.acordo_titulo_vinculo (titulo_id, acordo_id, ativo, vinculado_por)
select t.id, t.acordo_id, true, 'correcao 31/08: acordo pago, mensalidade seguia aberta'
  from public.acordos_titulos t
 where t.id in (select id from public._backup_vinculo_negociadas_20260831)
   and t.acordo_id is not null
   and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

-- Sem isto o saldo do aluno so muda na virada das 06:00.
-- Executado em prod em 31/08, aluno a aluno.
-- select public.recalcular_situacao_aluno(id, 'correcao_vinculo_31_08') from public.alunos where ...
