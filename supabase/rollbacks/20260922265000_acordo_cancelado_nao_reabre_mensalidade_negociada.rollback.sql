-- ROLLBACK de 20260922265000_acordo_cancelado_nao_reabre_mensalidade_negociada.sql
--
-- ROLLBACK DE CODIGO E COMPORTAMENTO. NAO E ROLLBACK DE DADOS.
--
-- Devolve as tres funcoes aos corpos EXATOS que estavam em producao em
-- 22/09/2026, capturados por `pg_get_functiondef` antes da migration e
-- guardados em
-- supabase/audits/acordo_cancelado_nao_reabre_mensalidade_producao_20260922.sql.
-- Os blocos abaixo sao copia literal daquele arquivo -- nao foram reescritos.
--
-- O QUE ESTE ROLLBACK NAO FAZ, POR DECISAO EXPLICITA DA GESTAO (22/09/2026):
--
--   * NAO faz saneamento nem reversao massiva de dados;
--   * NAO apaga historico criado enquanto a migration esteve ativa --
--     mensalidade que ficou NEGOCIADA continua NEGOCIADA, e o registro do que
--     aconteceu permanece;
--   * NAO reabre nem renegocia titulo em lote;
--   * NAO desfaz pagamento nenhum;
--   * NAO altera acordo existente por inferencia.
--
-- CONSEQUENCIA ASSUMIDA: depois deste rollback volta o comportamento anterior
-- -- cancelar um acordo devolve a mensalidade negociada para ABERTO, que e o
-- defeito que a migration corrigiu. O estado dos titulos que ja passaram pela
-- regra nova NAO e mexido; so o comportamento futuro muda.
--
-- As tres funcoes sao trocadas por CREATE OR REPLACE: nenhum DROP, nenhum
-- gatilho recriado, nenhuma tabela tocada. A assinatura de cada uma e
-- identica, entao os gatilhos existentes continuam apontando para elas.

-- -------------------------------------------------------------------------
-- 1 de 3. public.titulo_reavaliar(uuid)
--    Versao de 22/09/2026, que ja inclui a guarda de CANCELADA de 13/09
--    (migration 20260913230000_titulo_reavaliar_cancelada_e_estado_terminal).
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.titulo_reavaliar(p_titulo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_situacao text; v_status text;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
begin
  select situacao, status into v_situacao, v_status
    from public.acordos_titulos where id = p_titulo;
  if not found then return; end if;

  -- Ja paga: nada aqui reabre mensalidade quitada.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return;
  end if;

  -- Ja cancelada: nada aqui ressuscita titulo cancelado. Cancelar e uma decisao
  -- deliberada (rotina ou gestao); a reavaliacao automatica nao desfaz decisao.
  -- Voltar a cobrar exige um caminho explicito, que hoje nao existe -- e quando
  -- existir sera um "desfazer" com registro, nao um efeito colateral daqui.
  if upper(coalesce(v_situacao,'')) = 'CANCELADA'
     or lower(coalesce(v_status,'')) = 'cancelada' then
    return;
  end if;

  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
    into v_acordo, v_status_acordo, v_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  -- Sem acordo vivo: a divida volta a ser cobrada. O vinculo continua na
  -- tabela, entao a composicao do acordo nao se perde -- ver a tela do acordo.
  if v_acordo is null then
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
    return;
  end if;

  -- Quitado de verdade e acordo sem parcela viva. Acordo marcado QUITADO com
  -- parcela em aberto nao quita mensalidade nenhuma (guarda de 20260831140000).
  -- RENEGOCIADA nao entra aqui: parcela renegociada nao e parcela paga.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'));

  if v_quitado then
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           motivo_ajuste = coalesce(motivo_ajuste,'')
             || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           atualizado_em = now()
     where id = p_titulo;
  else
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  end if;
end;
$function$;

-- -------------------------------------------------------------------------
-- 2 de 3. public.titulos_por_status_acordo()
--    Gatilho em `acordos`: e a funcao que reabria a mensalidade ao cancelar.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.titulos_por_status_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'QUITADO' then
    update public.acordos_titulos t set situacao = 'PAGO', atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('ABERTO','NEGOCIADO');

  elsif new.status = 'CANCELADO' then
    -- a MENSALIDADE volta a ser cobravel: o acordo que a substituia caiu
    update public.acordos_titulos t set situacao = 'ABERTO', atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao = 'NEGOCIADO'
       and coalesce(t.tipo_boleto,'') <> 'Acordo';

    -- o BOLETO DO PROPRIO ACORDO morre junto com ele, tendo mensalidade
    -- vinculada ou nao. Ele nunca foi divida: e o numero do documento.
    update public.acordos_titulos t
       set situacao = 'CANCELADA',
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'boleto do proprio acordo, cancelado junto com o acordo em '
             || to_char(now(),'DD/MM/YYYY'),
           atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('NEGOCIADO','ABERTO')
       and coalesce(t.tipo_boleto,'') = 'Acordo';
  end if;

  return new;
end;
$function$;

-- -------------------------------------------------------------------------
-- 3 de 3. public.cancelar_acordo_ficha(uuid)
--    A RPC que a tela chama no botao de cancelar acordo.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancelar_acordo_ficha(p_acordo_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_agora    timestamptz := now();
  v_acordo   public.acordos%rowtype;
  v_titulos  int := 0;
  v_vinculos int := 0;
  v_parcelas int := 0;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Cancelar acordo e exclusivo da gestao financeira.' using errcode = '42501';
  end if;

  select * into v_acordo from public.acordos where id = p_acordo_id for update;
  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo ja esta cancelado.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.parcelas where acordo_id = p_acordo_id and upper(coalesce(status, '')) = 'PAGO') then
    raise exception 'Esse acordo ja tem parcela paga -- nao da pra cancelar (protege o historico financeiro). Se foi um erro, fale com quem confirmou o pagamento antes de mexer.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.baixas_pagamento where acordo_id = p_acordo_id and devolvido_em is null) then
    raise exception 'Esse acordo ja tem alguma baixa/pagamento registrado -- nao da pra cancelar por aqui.' using errcode = 'P0001';
  end if;

  update public.acordos_titulos t
     set status = 'em_aberto', atualizado_em = v_agora
   where t.id in (select v.titulo_id from public.acordo_titulo_vinculo v where v.acordo_id = p_acordo_id);
  get diagnostics v_titulos = row_count;

  delete from public.acordo_titulo_vinculo where acordo_id = p_acordo_id;
  get diagnostics v_vinculos = row_count;

  update public.parcelas
     set status = 'CANCELADA', atualizado_em = v_agora
   where acordo_id = p_acordo_id
     and upper(coalesce(status, '')) <> 'PAGO';
  get diagnostics v_parcelas = row_count;

  update public.acordos
     set status = 'CANCELADO', saldo = 0, atualizado_em = v_agora
   where id = p_acordo_id;

  if v_acordo.aluno_id is not null then
    perform public.liberar_caso_por_evento(v_acordo.aluno_id, 'CANCELADO');
  end if;

  return jsonb_build_object(
    'ok', true,
    'acordo_id', p_acordo_id,
    'titulos_reabertos', v_titulos,
    'vinculos_removidos', v_vinculos,
    'parcelas_canceladas', v_parcelas
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- PROVA DO ROLLBACK
-- ---------------------------------------------------------------------------

do $prova$
begin
  -- as tres continuam existindo, com a mesma assinatura
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='titulo_reavaliar') then
    raise exception 'titulo_reavaliar sumiu';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='titulos_por_status_acordo') then
    raise exception 'titulos_por_status_acordo sumiu';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='cancelar_acordo_ficha') then
    raise exception 'cancelar_acordo_ficha sumiu';
  end if;

  -- o gatilho que usa titulos_por_status_acordo continua no lugar
  if not exists (select 1 from pg_trigger
                  where tgrelid='public.acordos'::regclass and not tgisinternal) then
    raise exception 'os gatilhos de acordos sumiram';
  end if;

  -- NENHUMA tabela financeira foi tocada por este arquivo: ele so tem
  -- CREATE OR REPLACE FUNCTION. Se algum dia alguem acrescentar DML aqui,
  -- esta prova nao pega -- por isso o teste de rollback tambem conta as linhas.
end $prova$;
