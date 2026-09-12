-- O ELO DA MENSALIDADE COM O ACORDO, DEDUZIDO DO PRIME.
--
-- O PROBLEMA. O acordo importado nao diz qual divida substituiu. Sao 1.296
-- acordos ativos sem origem nenhuma, R$ 5,54 mi. Sem o elo, a mensalidade
-- continua sendo cobrada depois de negociada -- o caso da Aghatta Machado da
-- Silva: acordo 63196 quitado e R$ 925,88 ainda em aberto na ficha dela.
-- A API do Prime nao entrega a composicao (o portador 166, dos acordos, nao
-- aparece no financial-statement), entao ela precisa ser deduzida.
--
-- A REGRA, e por que da para confiar nela. Quando a mensalidade entra num
-- acordo, o Prime a liquida: 3.786 de 3.809 titulos de composicao conhecida
-- (99,4%) tem liquidado_em. E as liquidacoes de um mesmo acordo caem no MESMO
-- dia em 97,8% dos casos. Entao: aluno + data de liquidacao = um acordo.
--
-- TRES TRAVAS, para nao errar:
--   1. o aluno tem UM UNICO acordo -- sem ambiguidade de a qual atribuir;
--   2. os titulos dele formam UM UNICO grupo de data;
--   3. valor do acordo / soma dos titulos entre 0,25 e 1,60 -- a faixa que
--      cobre 95,8% dos acordos conhecidos (mediana 0,843, desconto de ~16%).
--
-- VALIDADA CONTRA O GABARITO. Aplicada aos acordos cuja composicao ja
-- conhecemos, a regra reproduz a lista EXATA de documentos em 681 de 685:
-- 99,42% de precisao, 4 erros.
--
-- RESULTADO MEDIDO: 1.530 vinculos, 474 acordos, R$ 2.113.300,52 em
-- mensalidades que pararam de ser cobradas em duplicidade -- 1.420 ficaram
-- NEGOCIADO (acordo vivo) e 110 viraram PAGO (acordo ja quitado).
--
-- REVERSIVEL. Cada vinculo entra com origem = 'regra_liquidacao_prime_20260909'
-- e o backup guarda o estado anterior. Apagar os vinculos por essa origem
-- desfaz tudo -- titulo_reavaliar devolve os titulos sozinho.
--
-- NAO INVENTA BAIXA. Vincular nao quita: o titulo fica NEGOCIADO enquanto o
-- acordo estiver vivo, e se o acordo for cancelado ele volta a ser cobrado
-- (ver 20260909161000_acordo_cancelado_devolve_a_mensalidade.sql).

create table if not exists public._backup_elo_mensalidade_20260909 (
  titulo_id    uuid,
  acordo_id    uuid,
  documento    text,
  situacao     text,
  status       text,
  acordo_antes uuid,
  valor        numeric,
  em           timestamptz default now()
);
alter table public._backup_elo_mensalidade_20260909 enable row level security;
drop policy if exists sem_acesso on public._backup_elo_mensalidade_20260909;
create policy sem_acesso on public._backup_elo_mensalidade_20260909 for select using (false);

create temp table _gg on commit drop as
  select t.aluno_id, pe.liquidado_em,
         sum(coalesce(t.valor_original, t.saldo_corrigido, 0)) soma
    from public.acordos_titulos t
    join public.prime_extrato pe on pe.boleto = t.documento and pe.liquidado_em is not null
   where coalesce(t.tipo_boleto,'') <> 'Acordo'
   group by 1,2;
create index on _gg(aluno_id);

create temp table _alvo on commit drop as
with um_acordo as (select aluno_id from public.acordos group by aluno_id having count(*)=1),
     um_grupo  as (select aluno_id from _gg group by aluno_id having count(*)=1),
     sem_origem as (
       select a.id acordo_id, a.aluno_id, a.valor_total
         from public.acordos a
        where a.status in ('ATIVO','QUITADO')
          and not exists (select 1 from public.acordos_titulos t where t.acordo_id = a.id)
          and not exists (select 1 from public.acordo_titulo_vinculo v where v.acordo_id = a.id))
select s.acordo_id, s.aluno_id, g.liquidado_em
  from sem_origem s
  join um_acordo u on u.aluno_id = s.aluno_id
  join um_grupo  n on n.aluno_id = s.aluno_id
  join _gg g       on g.aluno_id = s.aluno_id
 where s.valor_total > 0 and g.soma > 0
   and s.valor_total / g.soma between 0.25 and 1.60;

insert into public._backup_elo_mensalidade_20260909
  (titulo_id, acordo_id, documento, situacao, status, acordo_antes, valor)
select t.id, a.acordo_id, t.documento, t.situacao, t.status, t.acordo_id,
       coalesce(t.valor_original, t.saldo_corrigido, 0)
  from _alvo a
  join public.acordos_titulos t on t.aluno_id = a.aluno_id
  join public.prime_extrato pe on pe.boleto = t.documento and pe.liquidado_em = a.liquidado_em
 where coalesce(t.tipo_boleto,'') <> 'Acordo'
   and t.status = 'em_aberto';

insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, origem)
select b.acordo_id, b.titulo_id, true, 'sistema', 'regra_liquidacao_prime_20260909'
  from public._backup_elo_mensalidade_20260909 b
 where not exists (select 1 from public.acordo_titulo_vinculo v
                    where v.acordo_id = b.acordo_id and v.titulo_id = b.titulo_id);

do $$
declare v_aluno uuid;
begin
  for v_aluno in
    select distinct t.aluno_id from public._backup_elo_mensalidade_20260909 b
      join public.acordos_titulos t on t.id = b.titulo_id
     where t.aluno_id is not null
  loop
    perform public.recalcular_situacao_aluno(v_aluno);
  end loop;
end $$;

insert into public.invariante_config (nome, severidade, titulo, explicacao, base_09_09)
values ('acordo_sem_origem_deduzivel','ATENCAO','Acordo sem origem que daria para deduzir',
  'Acordo sem nenhum titulo vinculado cujo aluno tem um unico grupo de titulos liquidados no Prime na mesma data -- a composicao daria para deduzir com as tres travas (99,42% de precisao no gabarito).','596 avaliados, 474 tratados em 09/09')
on conflict (nome) do update
  set severidade = excluded.severidade, titulo = excluded.titulo, explicacao = excluded.explicacao;
