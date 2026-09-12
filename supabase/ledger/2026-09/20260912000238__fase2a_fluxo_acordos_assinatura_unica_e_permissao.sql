-- Fase 2A. Conserta tres defeitos que a minha mudanca da Fase 1 introduziu.
--
-- 1) ASSINATURA DUPLICADA. `create or replace` com um parametro novo criou uma
--    SEGUNDA funcao em vez de substituir a primeira. Ficaram duas:
--      (p_confirmar boolean)                      -> antiga, 6466 chars
--      (p_confirmar boolean, p_registrar boolean) -> nova, 8114 chars
--    O cron chama com UM argumento, e o Postgres resolve pela aridade exata:
--    ia para a ANTIGA, que ainda chama acordo_divergencias_mapear() fora do
--    guard. A correcao do dry-run nunca esteve no caminho do cron.
--
-- 2) PERMISSAO ABERTA. A funcao nova nasceu com o default permissivo do
--    Supabase: `anon` e `authenticated` podiam executa-la. Ela e SECURITY
--    DEFINER, escreve em `parcelas` e `acordo_titulo_vinculo`, e com
--    p_confirmar=true chama baixas_sem_lastro_excluir(true), que APAGA baixa.
--    A versao antiga tinha grant revogado; a nova perdeu essa protecao.
--
-- 3) statement_timeout PERDIDO. A antiga tinha 300s; a nova ficou sem.
--
-- Nada de dado e tocado aqui: some uma funcao duplicada, volta um timeout e
-- fecham-se permissoes. O cron continua DESARMADO.
--
-- Muda tambem o default de p_registrar para NULL, com efeito
-- coalesce(p_registrar, p_confirmar): em ensaio nao grava nem a linha de log,
-- e em confirmacao grava como sempre. Assim `fluxo_acordos_rodar(false)` --
-- exatamente a forma que o cron usa -- fica 100% somente leitura.

drop function if exists public.fluxo_acordos_rodar(boolean);

create or replace function public.fluxo_acordos_rodar(
  p_confirmar boolean,
  p_registrar boolean default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '300s'
as $fn$
declare
  e record; v_n int; v_v numeric; v_t timestamptz; v_res jsonb := '[]'::jsonb; r record;
  v_log boolean := coalesce(p_registrar, p_confirmar);
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
             and nv.status in ('ATIVO','QUITADO') and nv.id <> p.acordo_id
             and exists (select 1 from public.parcelas pp where pp.acordo_id = nv.id and pp.status = 'PAGO'))
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
           and nv.status in ('ATIVO','QUITADO') and nv.id <> p.acordo_id
           and exists (select 1 from public.parcelas pp where pp.acordo_id = nv.id and pp.status = 'PAGO');
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

    -- Em ensaio o default agora e NAO gravar nem log: coalesce(p_registrar, p_confirmar).
    if v_log then
      insert into public.fluxo_acordos_log (etapa, tratados, valor, ensaio, duracao_ms)
      values (e.etapa, coalesce(v_n,0), nullif(v_v,0), not p_confirmar,
              extract(milliseconds from clock_timestamp()-v_t)::int);
    end if;

    v_res := v_res || jsonb_build_array(
      jsonb_build_object('etapa', e.etapa, 'tratados', coalesce(v_n,0), 'valor', round(coalesce(v_v,0),2)));
  end loop;

  -- O mapa APAGA e reescreve acordo_divergencia: nunca em ensaio.
  if p_confirmar then
    perform public.acordo_divergencias_mapear();
  end if;

  return jsonb_build_object('ensaio', not p_confirmar, 'registrou_log', v_log,
    'etapas', v_res,
    'mapa', case when p_confirmar then 'refeito' else 'nao tocado (ensaio)' end);
end;
$fn$;

-- Fecha a permissao: SECURITY DEFINER que escreve em parcelas nao pode ser
-- chamavel por anon/authenticated. Restaura o estado que a versao antiga tinha.
revoke all on function public.fluxo_acordos_rodar(boolean, boolean) from public;
revoke all on function public.fluxo_acordos_rodar(boolean, boolean) from anon;
revoke all on function public.fluxo_acordos_rodar(boolean, boolean) from authenticated;

-- Mesmo problema nas outras duas funcoes que nasceram na Fase 1.
revoke all on function public.pagamentos_detectar_suspeita_duplicidade(uuid) from public, anon, authenticated;
revoke all on function public.fila_caso_faltando_atualizar(uuid) from public, anon, authenticated;
