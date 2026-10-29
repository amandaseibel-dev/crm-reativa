-- Mensalidade vinculada a acordo JA quitado nasce quitada.
--
-- Amanda, 02/09: "ontem tinhamos definido, se o acordo quitar, sera o status das
-- mensalidades do bordero, se for negociacao e ainda nao quitou o acordo
-- continua como negociado".
--
-- A REGRA JA EXISTE -- ela so nao alcanca este caminho. `_titulo_quita_com_o_acordo`
-- (20260831140000) marca PAGO/quitada quando o ACORDO VIRA quitado: e um
-- `after update of status` on acordos. Se o acordo ja estava quitado ANTES do
-- vinculo, nada dispara -- e o gatilho do vinculo, `titulo_situacao_por_vinculo`,
-- grava NEGOCIADO/vinculada em qualquer caso. A mensalidade fica no meio do
-- caminho: ligada a um acordo pago e ainda contando no saldo.
--
-- O CASO QUE PROVOU. Luimar Santos da Silva, acordo 1183, QUITADO em 18/08 pela
-- confirmacao de pagamento (parcela unica PAGO). As 6 mensalidades foram
-- vinculadas hoje as 11:32:57, o recalculo rodou as 11:34 -- e o caso seguiu
-- COBRANCA_VENCIDA com saldo de R$ 1.279,35, que e exatamente a soma das seis.
--
-- O QUE ENTRA: o estado da mensalidade segue o status do acordo NO MOMENTO DO
-- VINCULO, e nao so na virada dele.
--   acordo QUITADO   -> situacao PAGO,      status quitada     (o acordo dela foi pago)
--   acordo ATIVO     -> situacao NEGOCIADO, status vinculada   (negociada, ainda nao paga)
--   acordo CANCELADO -> a divida voltou; vincular ja e bloqueado, nada muda
--
-- A TRAVA QUE FICA DE PE: acordo marcado QUITADO com parcela viva nao quita
-- mensalidade nenhuma -- a mesma guarda de 20260831140000. Quitado de verdade e
-- acordo com todas as parcelas PAGO ou CANCELADA.
--
-- NAO APAGA DIVIDA E NAO ZERA VALOR. O valor continua na ficha, no bloco das
-- mensalidades do acordo. O que muda e parar de cobrar a mesma divida duas
-- vezes -- uma na parcela do acordo, outra na mensalidade que ele substituiu.
--
-- DESFAZER O VINCULO CONTINUA FUNCIONANDO: `desvincular_titulos_acordo` devolve
-- a mensalidade para ABERTO/em_aberto sem olhar o status anterior.
--
-- REPARO DO QUE JA PASSOU: 21 mensalidades, 8 alunos, R$ 16.025,35 -- todas em
-- acordo quitado e sem nenhuma parcela viva.
--
-- DESFAZER: supabase/rollbacks/20260902140000_mensalidade_segue_o_acordo_quitado.rollback.sql

-- ---------------------------------------------------------------------------
-- 1) O gatilho do vinculo passa a ler o status do acordo
-- ---------------------------------------------------------------------------
create or replace function public.titulo_situacao_por_vinculo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_titulos uuid[] := array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null);
  v_titulo uuid;
  v_situacao text;
  v_status text;
  v_acordo uuid;
  v_status_acordo text;
  v_numero text;
  v_quitado boolean;
begin
  foreach v_titulo in array v_titulos loop
    select situacao, status into v_situacao, v_status
      from public.acordos_titulos where id = v_titulo;

    -- ja paga: nada aqui reabre mensalidade quitada
    if upper(coalesce(v_situacao,'')) = 'PAGO'
       or lower(coalesce(v_status,'')) in ('quitada','paga') then
      continue;
    end if;

    select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
      into v_acordo, v_status_acordo, v_numero
      from public.acordo_titulo_vinculo v
      join public.acordos a on a.id = v.acordo_id
     where v.titulo_id = v_titulo
       and coalesce(v.ativo, true)
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     order by v.criado_em desc nulls last
     limit 1;

    if v_acordo is null then
      update public.acordos_titulos
         set situacao = 'ABERTO', status = 'em_aberto',
             acordo_id = null, atualizado_em = now()
       where id = v_titulo
         and (coalesce(situacao,'') <> 'ABERTO'
              or coalesce(status,'') <> 'em_aberto'
              or acordo_id is not null);
      continue;
    end if;

    -- Quitado de verdade e acordo sem parcela viva. Acordo marcado QUITADO com
    -- parcela em aberto nao quita mensalidade nenhuma (guarda de 20260831140000).
    v_quitado := v_status_acordo = 'QUITADO'
      and not exists (
        select 1 from public.parcelas p
         where p.acordo_id = v_acordo
           and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));

    if v_quitado then
      update public.acordos_titulos
         set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
             motivo_ajuste = coalesce(motivo_ajuste,'')
               || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
               || 'quitada junto com o acordo ' || v_numero
               || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
             atualizado_em = now()
       where id = v_titulo;
    else
      update public.acordos_titulos
         set situacao = 'NEGOCIADO', status = 'vinculada',
             acordo_id = v_acordo, atualizado_em = now()
       where id = v_titulo
         and (coalesce(situacao,'') <> 'NEGOCIADO'
              or coalesce(status,'') <> 'vinculada'
              or acordo_id is distinct from v_acordo);
    end if;
  end loop;

  return coalesce(new, old);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2) A RPC de vincular grava o estado certo de uma vez
--    (o gatilho acima ja corrigiria, mas a funcao tem de devolver a verdade
--     para a tela -- e a auditoria tem de registrar o que de fato aconteceu)
-- ---------------------------------------------------------------------------
create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_numero text;
  v_quitado boolean;
  v_bloqueados uuid[];
  v_n int;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0));

  select aluno_id, upper(coalesce(status,'')), coalesce(numero_acordo::text,'')
    into v_aluno_acordo, v_status_acordo, v_numero
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  -- Acordo cancelado devolveu a divida para cobranca: prender titulo nele
  -- esconderia divida viva. Quitado pode: registra que aquela divida foi paga
  -- por este acordo.
  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not (
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and lower(coalesce(t.status,'')) not in
            ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
      and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
      and (
            coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
        -- Ja negociado e sem acordo: orfao. Nao esta sendo cobrado de ninguem,
        -- entao trava-lo nao protege nada -- so impede o conserto.
        or upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
      )
    );

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object('ok',false,'erro','PARCELAS_INELEGIVEIS','bloqueados', to_jsonb(v_bloqueados));
  end if;

  -- O estado da mensalidade segue o acordo: pago vira pago, negociado vira
  -- negociado. So conta como quitado o acordo sem nenhuma parcela viva.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = p_acordo_id
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));

  if v_quitado then
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = 'PAGO', status = 'quitada',
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo;
  else
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo;
  end if;
  get diagnostics v_n = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n,
                             'status_acordo', v_status_acordo,
                             'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end,
                             'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'acordo_id', p_acordo_id,
                            'status_acordo', v_status_acordo,
                            'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Reparo do que ja foi vinculado a acordo quitado e ficou negociado
-- ---------------------------------------------------------------------------
create table if not exists public._backup_titulo_acordo_quitado_20260902 as
select t.*, now() as backup_em
  from public.acordos_titulos t
 where exists (
   select 1 from public.acordo_titulo_vinculo v
   join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = t.id and coalesce(v.ativo,true)
     and upper(coalesce(a.status,'')) = 'QUITADO'
     and not exists (select 1 from public.parcelas p
                      where p.acordo_id = a.id
                        and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA')))
   and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
   and coalesce(t.tipo_boleto,'') <> 'Acordo';

alter table public._backup_titulo_acordo_quitado_20260902 enable row level security;

update public.acordos_titulos t
   set situacao = 'PAGO', status = 'quitada',
       acordo_id = coalesce(t.acordo_id, b.acordo),
       motivo_ajuste = coalesce(t.motivo_ajuste,'')
         || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
         || 'quitada junto com o acordo ' || b.numero
         || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
       atualizado_em = now()
  from (
    select bk.id,
           (select v.acordo_id from public.acordo_titulo_vinculo v
             where v.titulo_id = bk.id and coalesce(v.ativo,true)
             order by v.criado_em desc nulls last limit 1) acordo,
           (select coalesce(a.numero_acordo::text,'') from public.acordo_titulo_vinculo v
             join public.acordos a on a.id = v.acordo_id
             where v.titulo_id = bk.id and coalesce(v.ativo,true)
             order by v.criado_em desc nulls last limit 1) numero
      from public._backup_titulo_acordo_quitado_20260902 bk
  ) b
 where t.id = b.id;

-- o saldo de cada aluno tocado volta a bater na hora
do $do$
declare r record;
begin
  for r in (select distinct aluno_id from public._backup_titulo_acordo_quitado_20260902
             where aluno_id is not null)
  loop
    begin perform public.recalcular_situacao_aluno(r.aluno_id, 'titulo_segue_acordo_quitado');
    exception when others then null; end;
  end loop;
end $do$;
