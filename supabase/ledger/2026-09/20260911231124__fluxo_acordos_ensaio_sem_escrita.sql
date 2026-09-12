-- Ensaio do fluxo de acordos passa a ser 100% somente leitura.
--
-- Antes, p_confirmar=false ainda escrevia em dois lugares:
--   1. `fluxo_acordos_log` (1 linha por etapa);
--   2. `acordo_divergencias_mapear()`, chamada FORA do if p_confirmar -- e ela
--      da DELETE na acordo_divergencia antes de remapear. Hoje ha 2.639 linhas
--      com tratado_em preenchido; um dry-run reescreveria a tabela inteira.
-- E a etapa elo_mensalidade criava duas temp tables (DDL).
--
-- Agora: acordo_divergencias_mapear() so com p_confirmar=true; novo parametro
-- p_registrar (default true, preserva compatibilidade) controla a linha de log;
-- temp tables trocadas por CTE. Com (false,false) nao ha DML nem DDL.
--
-- Callers conferidos antes de mexer na assinatura: apenas o cron
-- `fluxo_acordos_diario` (active=false), nenhuma funcao, nenhum grant, nenhuma
-- RPC exposta. A chamada de 1 argumento continua valida pelo default.

create or replace function public.fluxo_acordos_rodar(
  p_confirmar boolean,
  p_registrar boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  e record; v_n int; v_v numeric; v_t timestamptz; v_res jsonb := '[]'::jsonb; r record;
begin
  for e in select * from public.fluxo_acordos_config where ligado order by ordem loop
    v_t := clock_timestamp(); v_n := 0; v_v := 0;

    if e.etapa = 'parcela_re_acordada' then
      -- Acordo novo CANCELADO fica de fora: a divida voltou para a parcela.
      if p_confirmar then
        with alvo as (
          select p.id, nv.id novo from public.parcelas p
            join public.acordos_titulos t on t.documento = '0' || p.boleto
            join public.acordos nv on nv.id = t.acordo_id
           where p.boleto is not null and p.status in ('VENCIDA','A_VENCER')
             and nv.status in ('ATIVO','QUITADO')
             and nv.id <> p.acordo_id
             and exists (select 1 from public.parcelas pp
                          where pp.acordo_id = nv.id and pp.status = 'PAGO'))
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
           and nv.status in ('ATIVO','QUITADO')
           and nv.id <> p.acordo_id
           and exists (select 1 from public.parcelas pp
                        where pp.acordo_id = nv.id and pp.status = 'PAGO');
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
      -- Nunca toca em baixa assinada. Reaproveita o executor ja testado.
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
      -- A TRAVA QUE FALTOU: acordo tem que ter parcela paga.
      -- Sem temp table: em ensaio nao pode haver nem DDL.
      with g as (
        select t.aluno_id, pe.liquidado_em,
               sum(coalesce(t.valor_original,t.saldo_corrigido,0)) soma
          from public.acordos_titulos t
          join public.prime_extrato pe on pe.boleto=t.documento and pe.liquidado_em is not null
         where coalesce(t.tipo_boleto,'')<>'Acordo' and t.status='em_aberto'
         group by 1,2),
      um_acordo as (select aluno_id from public.acordos group by aluno_id having count(*)=1),
      um_grupo  as (select aluno_id from g group by aluno_id having count(*)=1),
      alv as (
        select a.id acordo_id, a.aluno_id, g.liquidado_em
          from public.acordos a
          join um_acordo u on u.aluno_id=a.aluno_id
          join um_grupo  n on n.aluno_id=a.aluno_id
          join g on g.aluno_id=a.aluno_id
         where a.status in ('ATIVO','QUITADO')
           and a.valor_total > 0 and g.soma > 0
           and a.valor_total / g.soma between 0.25 and 1.60
           and exists (select 1 from public.parcelas p where p.acordo_id=a.id and p.status='PAGO')
           and not exists (select 1 from public.acordos_titulos t2 where t2.acordo_id=a.id)
           and not exists (select 1 from public.acordo_titulo_vinculo v2 where v2.acordo_id=a.id))
      select count(*) into v_n
        from alv al
        join public.acordos_titulos t on t.aluno_id=al.aluno_id
        join public.prime_extrato pe on pe.boleto=t.documento and pe.liquidado_em=al.liquidado_em
       where coalesce(t.tipo_boleto,'')<>'Acordo' and t.status='em_aberto';

      if p_confirmar and v_n > 0 then
        with g as (
          select t.aluno_id, pe.liquidado_em,
                 sum(coalesce(t.valor_original,t.saldo_corrigido,0)) soma
            from public.acordos_titulos t
            join public.prime_extrato pe on pe.boleto=t.documento and pe.liquidado_em is not null
           where coalesce(t.tipo_boleto,'')<>'Acordo' and t.status='em_aberto'
           group by 1,2),
        um_acordo as (select aluno_id from public.acordos group by aluno_id having count(*)=1),
        um_grupo  as (select aluno_id from g group by aluno_id having count(*)=1),
        alv as (
          select a.id acordo_id, a.aluno_id, g.liquidado_em
            from public.acordos a
            join um_acordo u on u.aluno_id=a.aluno_id
            join um_grupo  n on n.aluno_id=a.aluno_id
            join g on g.aluno_id=a.aluno_id
           where a.status in ('ATIVO','QUITADO')
             and a.valor_total > 0 and g.soma > 0
             and a.valor_total / g.soma between 0.25 and 1.60
             and exists (select 1 from public.parcelas p where p.acordo_id=a.id and p.status='PAGO')
             and not exists (select 1 from public.acordos_titulos t2 where t2.acordo_id=a.id)
             and not exists (select 1 from public.acordo_titulo_vinculo v2 where v2.acordo_id=a.id))
        insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, origem)
        select al.acordo_id, t.id, true, 'sistema', 'fluxo_acordos_diario'
          from alv al
          join public.acordos_titulos t on t.aluno_id=al.aluno_id
          join public.prime_extrato pe on pe.boleto=t.documento and pe.liquidado_em=al.liquidado_em
         where coalesce(t.tipo_boleto,'')<>'Acordo' and t.status='em_aberto'
           and not exists (select 1 from public.acordo_titulo_vinculo v3
                            where v3.acordo_id=al.acordo_id and v3.titulo_id=t.id);
      end if;
    end if;

    -- Em ensaio puro (p_registrar=false) nem o log e gravado.
    if p_registrar then
      insert into public.fluxo_acordos_log (etapa, tratados, valor, ensaio, duracao_ms)
      values (e.etapa, coalesce(v_n,0), nullif(v_v,0), not p_confirmar,
              extract(milliseconds from clock_timestamp()-v_t)::int);
    end if;

    v_res := v_res || jsonb_build_array(
      jsonb_build_object('etapa', e.etapa, 'tratados', coalesce(v_n,0), 'valor', round(coalesce(v_v,0),2)));
  end loop;

  -- O mapa de divergencias APAGA e reescreve acordo_divergencia. Isso nunca
  -- pode acontecer em ensaio.
  if p_confirmar then
    perform public.acordo_divergencias_mapear();
  end if;

  return jsonb_build_object('ensaio', not p_confirmar, 'registrou_log', p_registrar,
    'etapas', v_res,
    'mapa', case when p_confirmar then 'refeito' else 'nao tocado (ensaio)' end);
end;
$fn$;
