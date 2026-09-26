-- Varredura: corrigir TODOS os casos de cada defeito achado hoje, nao um por um.
--
-- Amanda, 31/08: "mas se existe um erro ele precisa ser corrigido em todos os
-- casos". Estava certa -- o dia inteiro eu consertei o caso apontado mais a
-- causa, sem varrer a base atras dos iguais.
--
-- A varredura completa, depois dos consertos do dia, achou pouca coisa:
--
--   1. saldo gravado difere do recalculado        2 casos   R$ 13.496,63
--   2. titulo NEGOCIADO sem status 'vinculada'    2 casos   R$  1.184,18
--   3. titulo NEGOCIADO sem linha de vinculo      2 casos   (os mesmos 2)
--   4. vinculo ativo com titulo fora de NEGOCIADO 0 casos
--   5. acordo QUITADO com parcela nao paga        1 caso    R$  1.844,42
--   6. caso quitado com mensalidade em aberto     2 casos   R$ 19.377,55
--
-- CORRIGE 1, 2/3 e 5. O item 6 fica de fora de proposito: sao a Vitoria Santana
-- e o Elisson Avelino, residuo de quitacao parcial anterior a 28/08, e escolher
-- entre zerar a divida ou desfazer a quitacao e decisao da gestao.
--
-- ITEM 1 -- Ozias Ferreira Lemos Junior (55.929,11 -> 43.100,36) e Vitoria Alves
-- Martins Duarte (1.667,94 -> 1.000,06). So recalculo.
--
-- ITEM 2/3 -- Josidelma Pereira Silva, dois titulos de R$ 592,09 marcados
-- NEGOCIADO com `acordo_id` nulo e sem linha de vinculo. NEGOCIADO significa
-- "ligado a um acordo"; sem ligacao nenhuma o rotulo e falso. Eles JA contam
-- como divida -- a exclusao do saldo depende do vinculo, nao do rotulo -- entao
-- voltar para ABERTO nao mexe em um centavo: so faz o rotulo dizer a verdade e
-- devolve os dois para serem vinculados direito. Ela tem DOIS acordos ativos,
-- entao escolher a qual ligar seria adivinhacao.
--
-- ITEM 5 -- acordo QUITADO com uma parcela que nunca virou PAGO (Lucas Goncalves
-- dos Santos). Desde 20260831150000 o saldo ja ignora parcela de acordo quitado,
-- entao isto nao muda valor: so alinha o dado ao que o status do acordo afirma.
--
-- DESFAZER: supabase/rollbacks/20260831240000_varredura_consistencia_31_08.rollback.sql

create table if not exists public._backup_varredura_31_08 as
select 'titulo_negociado_sem_vinculo' as origem, t.* , now() as backup_em
  from public.acordos_titulos t
 where upper(coalesce(t.situacao,''))='NEGOCIADO'
   and (lower(coalesce(t.status,'')) <> 'vinculada'
        or not exists (select 1 from public.acordo_titulo_vinculo v
                        where v.titulo_id = t.id and coalesce(v.ativo,true)));

alter table public._backup_varredura_31_08 enable row level security;

create table if not exists public._backup_varredura_parcelas_31_08 as
select p.*, now() as backup_em
  from public.acordos a join public.parcelas p on p.acordo_id = a.id
 where upper(coalesce(a.status,''))='QUITADO'
   and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

alter table public._backup_varredura_parcelas_31_08 enable row level security;

update public.acordos_titulos t
   set situacao = 'ABERTO', status = 'em_aberto',
       motivo_ajuste = coalesce(motivo_ajuste,'')
                       || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
                       || 'estava NEGOCIADO sem vinculo nenhum: voltou a ABERTO em 31/08/2026 para ser vinculado direito',
       atualizado_em = now()
 where t.id in (select id from public._backup_varredura_31_08);

update public.parcelas p
   set status = 'PAGO', atualizado_em = now()
 where p.id in (select id from public._backup_varredura_parcelas_31_08);
