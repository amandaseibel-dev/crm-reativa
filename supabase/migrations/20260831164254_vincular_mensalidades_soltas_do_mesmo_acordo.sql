-- Mensalidade que ficou de fora de um acordo que ja levou as outras.
--
-- Amanda, 31/08: "ajuste os dados no relatorio" e, depois de ver a lista nome a
-- nome, "pode seguir".
--
-- O CASO. No relatorio de jan-jun ha 459 CPFs com exatamente UM acordo ATIVO que
-- mesmo assim aparecem como divida crua. Vincular todos seria errado -- em 292
-- deles o acordo e MENOR que a divida, e vincular apagaria R$ 826 mil que o
-- acordo nao cobre.
--
-- Esta migration mexe so onde a prova fecha: acordos que JA TEM mensalidades
-- vinculadas e nos quais as vinculadas SUPERAM as soltas. Ali a leitura e direta
-- -- o acordo levou o grupo e uma ou duas ficaram para tras, o mesmo padrao
-- corrigido em 20260831140000.
--
--   aluno                          vinculadas  soltas   valor solto
--   Matheus Evaldt Borges               5        2       R$ 1.240,82
--   Vitoria Ribeiro Linhares            5        2       R$ 1.528,34
--   Jacinara Marinho da Mota            5        4       R$ 1.583,10
--   Rafaela Silveira Cabral             4        2       R$ 3.143,10
--                                                        -----------
--                                                        R$ 7.495,36
--
-- FICAM DE FORA, de proposito, os outros seis do grupo -- neles as soltas
-- empatam ou superam as vinculadas. O caso extremo e a Keli Heberle: UMA
-- vinculada e SEIS soltas (R$ 4.550,19). Ali o acordo claramente nao cobriu
-- tudo, e vincular apagaria divida real.
--
-- NAO ZERA NINGUEM. A Rafaela Silveira Cabral seguiu com R$ 7.402,87 depois do
-- ajuste: saiu so o que o acordo cobria.
--
-- O VINCULO EXIGE AS QUATRO PECAS (ver 20260831140000): situacao NEGOCIADO,
-- status 'vinculada', coluna acordo_id e linha ativa em acordo_titulo_vinculo.
-- E a ultima que tira do saldo. O recalculo vem por gatilho (20260831180000).
--
-- DESFAZER: supabase/rollbacks/20260831270000_vincular_mensalidades_soltas_do_mesmo_acordo.rollback.sql

create table if not exists public._backup_vinculo_soltas_20260831 as
with rel as (select distinct e.aluno_id from public._relatorio_2026_1_eleg() e),
alvo as (
  select r.aluno_id, a.id acordo_id,
         (select count(*) from public.acordo_titulo_vinculo v
           where v.acordo_id = a.id and coalesce(v.ativo,true)) vinculadas,
         (select count(*) from public.acordos_titulos t
           where t.aluno_id = r.aluno_id
             and t.vencimento between date '2026-01-01' and date '2026-06-30'
             and upper(coalesce(t.situacao,'')) = 'ABERTO'
             and t.acordo_id is null) soltas
    from rel r
    join public.acordos a on a.aluno_id = r.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO'
   where (select count(*) from public.acordos a2
           where a2.aluno_id = r.aluno_id and upper(coalesce(a2.status,'')) = 'ATIVO') = 1
     and exists (select 1 from public.acordo_titulo_vinculo v
                  where v.acordo_id = a.id and coalesce(v.ativo,true))
)
select t.*, al.acordo_id as acordo_destino, now() as backup_em
  from alvo al
  join public.acordos_titulos t on t.aluno_id = al.aluno_id
 where al.vinculadas > al.soltas
   and t.vencimento between date '2026-01-01' and date '2026-06-30'
   and upper(coalesce(t.situacao,'')) = 'ABERTO'
   and t.acordo_id is null;

alter table public._backup_vinculo_soltas_20260831 enable row level security;

update public.acordos_titulos t
   set acordo_id     = b.acordo_destino,
       situacao      = 'NEGOCIADO',
       status        = 'vinculada',
       vinculado_em  = now(),
       vinculado_por = 'ajuste 31/08: sobrou de um acordo que ja levou as outras',
       motivo_ajuste = coalesce(t.motivo_ajuste,'')
                       || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
                       || 'vinculada em 31/08/2026 -- o acordo ja tinha as demais mensalidades',
       atualizado_em = now()
  from public._backup_vinculo_soltas_20260831 b
 where t.id = b.id;

insert into public.acordo_titulo_vinculo (titulo_id, acordo_id, ativo, vinculado_por)
select b.id, b.acordo_destino, true, 'ajuste 31/08: sobrou de um acordo que ja levou as outras'
  from public._backup_vinculo_soltas_20260831 b
 where not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = b.id);
