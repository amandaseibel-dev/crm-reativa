-- O FLUXO DIARIO DOS ACORDOS -- com as regras que custaram um dia para aprender.
--
-- POR QUE ELE EXISTE. Tudo que corrigimos em 09/09 volta a acontecer amanha:
-- chegam acordos novos toda semana com o mesmo defeito. Corrigir uma vez a mao
-- e desperdicio; o que resolve e a regra virar rotina.
--
-- AS REGRAS QUE ELE OBEDECE, cada uma paga com um erro deste dia:
--   1. ACORDO SO VALE COM PAGAMENTO. Sem pagamento e simulacao: a divida
--      continua sendo da mensalidade. Ignorar isso vinculou 1.530 titulos
--      indevidamente -- 383 acordos eram simulacao, R$ 2.012.553,84.
--   2. NAO CANCELA, SEMPRE VINCULA. A divida nao some; para de somar e fica na
--      memoria do acordo. Cancelar faria o gatilho marcar 20 acordos como
--      "quitado automaticamente" -- R$ 46.415,00 de recuperacao inexistente.
--   3. BAIXA ASSINADA POR GENTE NUNCA SAI SOZINHA. Das 467 baixas sem pagamento,
--      332 eram da Amanda e da Fernanda -- legitimas.
--   4. NUNCA APLICAR COM EVIDENCIA DE UM LADO SO. O que depende do Prime e o
--      Prime nao entrega (portador 166) fica FORA deste fluxo, esperando.
--   5. GUARDA QUE ABORTA E GUARDA QUEBRADA. Nenhuma etapa derruba o lote.
--
-- SEM p_confirmar, o fluxo so CONTA. Esse e o modo padrao.
--
-- FICA DE FORA, de proposito: o corte da simulacao (quantos dias de 1a parcela
-- vencida) e as 383 baixas da maquina em C/D -- as duas esperam decisao da
-- gestao e o portador 166, respectivamente.

create table if not exists public.fluxo_acordos_config (
  etapa      text primary key,
  ligado     boolean not null default true,
  ordem      integer not null,
  titulo     text not null,
  explicacao text
);

create table if not exists public.fluxo_acordos_log (
  id         bigserial primary key,
  etapa      text not null,
  tratados   integer not null default 0,
  valor      numeric,
  detalhe    jsonb,
  ensaio     boolean not null default true,
  rodado_em  timestamptz not null default now(),
  duracao_ms integer
);
create index if not exists ix_fluxo_acordos_log_data on public.fluxo_acordos_log (rodado_em desc);

alter table public.fluxo_acordos_config enable row level security;
alter table public.fluxo_acordos_log    enable row level security;
drop policy if exists fac_gestao on public.fluxo_acordos_config;
create policy fac_gestao on public.fluxo_acordos_config for select using (public.usuario_e_gestao());
drop policy if exists fal_gestao on public.fluxo_acordos_log;
create policy fal_gestao on public.fluxo_acordos_log for select using (public.usuario_e_gestao());

insert into public.fluxo_acordos_config (etapa, ordem, titulo, explicacao) values
 ('parcela_re_acordada', 1, 'Parcela renegociada para de dobrar',
  'A parcela cujo boleto virou titulo negociado num acordo novo recebe o vinculo e o estado RENEGOCIADA. Nao cancela. Acordo novo CANCELADO fica de fora: a divida voltou.'),
 ('mensalidade_de_acordo_cancelado', 2, 'Acordo cancelado devolve a mensalidade',
  'Rede de seguranca: o gatilho ja faz isso, mas se algum caminho escapar, a varredura devolve.'),
 ('baixa_sem_lastro', 3, 'Exclui a baixa que nenhum pagamento sustenta',
  'Parcela paga sem pagamento algum do acordo E sem ninguem ter assinado. Baixa assinada por gente NUNCA entra.'),
 ('elo_mensalidade', 4, 'Vincula a mensalidade ao acordo que a substituiu',
  'Aluno com um unico acordo, um unico grupo de liquidacao no Prime, razao de valor entre 0,25 e 1,60 E ACORDO COM PAGAMENTO. 99,42% de precisao no gabarito.')
on conflict (etapa) do update
  set titulo = excluded.titulo, explicacao = excluded.explicacao, ordem = excluded.ordem;

create or replace function public.fluxo_acordos_rodar(p_confirmar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $fn$
declare
  e record; v_n int; v_v numeric; v_t timestamptz; v_res jsonb := '[]'::jsonb; r record;
begin
  for e in select * from public.fluxo_acordos_config where ligado order by ordem loop
    v_t := clock_timestamp(); v_n := 0; v_v := 0;

    if e.etapa = 'parcela_re_acordada' then
      if p_confirmar then
        with alvo as (
          select p.id, nv.id novo from public.parcelas p
            join public.acordos_titulos t on t.documento = '0' || p.boleto
            join public.acordos nv on nv.id = t.acordo_id
           where p.boleto is not null and p.status in ('VENCIDA','A_VENCER')
             and nv.status in ('ATIVO','QUITADO'))
        update public.parcelas p
           set status='RENEGOCIADA', renegociada_em=now(),
               renegociada_no_acordo_id=a.novo, atualizado_em=now()
          from alvo a where a.id=p.id;
        get diagnostics v_n = row_count;
      else
        select count(*), coalesce(sum(p.valor),0) into v_n, v_v
          from public.parcelas p
          join public.acordos_titulos t on t.documento = '0' || p.boleto
          join public.acordos nv on nv.id = t.acordo_id
         where p.boleto is not null and p.status in ('VENCIDA','A_VENCER')
           and nv.status in ('ATIVO','QUITADO');
      end if;

    elsif e.etapa = 'mensalidade_de_acordo_cancelado' then
      select count(*) into v_n
        from public.acordo_titulo_vinculo vin
        join public.acordos a on a.id = vin.acordo_id
                             and upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA')
        join public.acordos_titulos t on t.id = vin.titulo_id
       where t.status='vinculada' and upper(coalesce(t.situacao,''))='NEGOCIADO';
      if p_confirmar and v_n > 0 then
        for r in select t.id from public.acordo_titulo_vinculo vin
                   join public.acordos a on a.id=vin.acordo_id
                                        and upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA')
                   join public.acordos_titulos t on t.id=vin.titulo_id
                  where t.status='vinculada' and upper(coalesce(t.situacao,''))='NEGOCIADO'
        loop perform public.titulo_reavaliar(r.id); end loop;
      end if;

    elsif e.etapa = 'baixa_sem_lastro' then
      if p_confirmar then
        v_res := v_res || jsonb_build_array(public.baixas_sem_lastro_excluir(true));
        select count(*) into v_n from public.parcelas p
         where p.status='PAGO' and p.boleto is not null and length(p.boleto)=11
           and p.confirmado_por_email is null
           and not exists (select 1 from public.pagamentos g
                            where substring(g.numero_parcela_completo,2,6)=substring(p.boleto,2,6));
      else
        select count(*), coalesce(sum(p.valor),0) into v_n, v_v from public.parcelas p
         where p.status='PAGO' and p.boleto is not null and length(p.boleto)=11
           and p.confirmado_por_email is null
           and not exists (select 1 from public.pagamentos g
                            where substring(g.numero_parcela_completo,2,6)=substring(p.boleto,2,6));
      end if;

    elsif e.etapa = 'elo_mensalidade' then
      create temp table _g on commit drop as
        select t.aluno_id, pe.liquidado_em,
               sum(coalesce(t.valor_original,t.saldo_corrigido,0)) soma
          from public.acordos_titulos t
          join public.prime_extrato pe on pe.boleto=t.documento and pe.liquidado_em is not null
         where coalesce(t.tipo_boleto,'')<>'Acordo' and t.status='em_aberto'
         group by 1,2;
      create temp table _alv on commit drop as
      with um_acordo as (select aluno_id from public.acordos group by aluno_id having count(*)=1),
           um_grupo  as (select aluno_id from _g group by aluno_id having count(*)=1)
      select a.id acordo_id, a.aluno_id, g.liquidado_em
        from public.acordos a
        join um_acordo u on u.aluno_id=a.aluno_id
        join um_grupo  n on n.aluno_id=a.aluno_id
        join _g g on g.aluno_id=a.aluno_id
       where a.status in ('ATIVO','QUITADO')
         and a.valor_total > 0 and g.soma > 0
         and a.valor_total / g.soma between 0.25 and 1.60
         and exists (select 1 from public.parcelas p where p.acordo_id=a.id and p.status='PAGO')
         and not exists (select 1 from public.acordos_titulos t2 where t2.acordo_id=a.id)
         and not exists (select 1 from public.acordo_titulo_vinculo v2 where v2.acordo_id=a.id);

      select count(*) into v_n
        from _alv al join public.acordos_titulos t on t.aluno_id=al.aluno_id
        join public.prime_extrato pe on pe.boleto=t.documento and pe.liquidado_em=al.liquidado_em
       where coalesce(t.tipo_boleto,'')<>'Acordo' and t.status='em_aberto';

      if p_confirmar and v_n > 0 then
        insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, origem)
        select al.acordo_id, t.id, true, 'sistema', 'fluxo_acordos_diario'
          from _alv al join public.acordos_titulos t on t.aluno_id=al.aluno_id
          join public.prime_extrato pe on pe.boleto=t.documento and pe.liquidado_em=al.liquidado_em
         where coalesce(t.tipo_boleto,'')<>'Acordo' and t.status='em_aberto'
           and not exists (select 1 from public.acordo_titulo_vinculo v3
                            where v3.acordo_id=al.acordo_id and v3.titulo_id=t.id);
      end if;
    end if;

    insert into public.fluxo_acordos_log (etapa, tratados, valor, ensaio, duracao_ms)
    values (e.etapa, coalesce(v_n,0), nullif(v_v,0), not p_confirmar,
            extract(milliseconds from clock_timestamp()-v_t)::int);

    v_res := v_res || jsonb_build_array(
      jsonb_build_object('etapa', e.etapa, 'tratados', coalesce(v_n,0), 'valor', round(coalesce(v_v,0),2)));
  end loop;

  return jsonb_build_object('ensaio', not p_confirmar, 'etapas', v_res);
end;
$fn$;

comment on function public.fluxo_acordos_rodar(boolean) is
  'Rotina diaria dos acordos. Sem p_confirmar, so conta. Obedece: acordo so vale com pagamento; nao cancela, vincula; baixa assinada por gente nunca sai sozinha; nenhuma etapa derruba o lote.';

revoke all on function public.fluxo_acordos_rodar(boolean) from public, anon, authenticated;

select cron.unschedule('fluxo_acordos_diario')
 where exists (select 1 from cron.job where jobname = 'fluxo_acordos_diario');

select cron.schedule('fluxo_acordos_diario', '40 9 * * *', $cron$
  do $inner$
  begin
    if public.sistema_sob_carga() then return; end if;
    perform public.fluxo_acordos_rodar(true);
  end
  $inner$;
$cron$);
