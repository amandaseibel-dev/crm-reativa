-- Amanda, 31/08: "precisamos uma forma de casar as mensalidades importada ao
-- acordo feito e pago" e "precisa fazer essa limpeza urgente".
--
-- A importacao de acordos insere o titulo do acordo como ABERTO e sem vinculo.
-- Nesse estado ele SOMA no saldo -- e se o mesmo acordo ja tem parcelas, a
-- divida passa a ser contada nas duas pontas.
--
-- Esta rotina trata os dois destinos possiveis de um titulo desses:
--   1. JA PAGO -- o documento aparece no extrato do Santander. Nao e divida:
--      vira PAGO/quitada.
--   2. DIVIDA VIVA -- casa com a parcela do acordo pelo NUMERO da parcela e
--      valor exato. Ganha vinculo e vira NEGOCIADO/vinculada, para a divida
--      ser contada UMA vez, pela parcela.
--
-- O que nao cai em nenhum dos dois FICA COMO ESTA. Nao se adivinha composicao:
-- ver [[prime-nao-enxerga-o-acordo]].
--
-- Sem p_confirmar a funcao so devolve a previa, nao escreve.
-- Temporarias com prefixo proprio: duas funcoes com temp table de mesmo nome
-- derrubaram 8 rodadas seguidas do fluxo -- ver
-- [[temporaria-com-mesmo-nome-derruba-o-fluxo]].

create or replace function public.acordos_pos_importacao(
  p_importacao_id uuid default null, p_confirmar boolean default false)
returns jsonb language plpgsql security definer
set search_path to 'public' set statement_timeout to '600s'
as $function$
declare
  v_pagos int := 0; v_amarrados int := 0; v_vinculados int := 0; v_alunos int := 0;
  v_valor_pago numeric := 0; v_valor_vinc numeric := 0; v_lote text;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  -- Alvo: titulos de acordo ABERTO e SEM vinculo -- o estado que SOMA no saldo.
  create temp table _alvo on commit drop as
  select t.id, t.aluno_id, t.documento, ltrim(t.documento,'0') chave,
         (right(t.documento,4))::int nr,
         coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) valor
    from public.acordos_titulos t
   where coalesce(t.tipo_boleto,'')='Acordo'
     and upper(coalesce(t.situacao,''))='ABERTO'
     and t.documento ~ '^\d{12}$'
     and (p_importacao_id is null or t.importacao_id = p_importacao_id)
     and not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id=t.id and coalesce(v.ativo,true));

  -- 1) JA PAGO: o documento aparece no extrato do Santander.
  create temp table _pago on commit drop as
  select distinct a.id, a.aluno_id, a.valor, p.data_pagamento
    from _alvo a join public.pagamentos p
      on ltrim(coalesce(p.numero_parcela_completo,''),'0') = a.chave;

  -- 2) O QUE SOBRA e divida viva: casa com a parcela do acordo pelo numero.
  create temp table _casa on commit drop as
  select distinct on (a.id) a.id titulo_id, a.aluno_id, a.chave, a.valor,
         pa.id parcela_id, pa.acordo_id
    from _alvo a
    join public.acordos ac on ac.aluno_id = a.aluno_id
    join public.parcelas pa on pa.acordo_id = ac.id and pa.numero = a.nr
   where not exists (select 1 from _pago pg where pg.id = a.id)
     and abs(pa.valor - a.valor) <= 0.05
     and pa.boleto is null
   order by a.id, abs(pa.valor - a.valor);

  select count(*), round(coalesce(sum(valor),0),2) into v_pagos, v_valor_pago from _pago;
  select count(*), round(coalesce(sum(valor),0),2) into v_vinculados, v_valor_vinc from _casa;
  select count(distinct aluno_id) into v_alunos
    from (select aluno_id from _pago union select aluno_id from _casa) x;

  if not coalesce(p_confirmar,false) then
    return jsonb_build_object('modo','previa',
      'titulos_no_alvo', (select count(*) from _alvo),
      'ja_pagos_no_extrato', v_pagos, 'valor_ja_pago', v_valor_pago,
      'casam_com_parcela', v_vinculados, 'valor_a_vincular', v_valor_vinc,
      'sobram_sem_tratamento',
        (select count(*) from _alvo a where not exists (select 1 from _pago p where p.id=a.id)
           and not exists (select 1 from _casa c where c.titulo_id=a.id)),
      'alunos', v_alunos);
  end if;

  v_lote := to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  execute format('create table if not exists public.%I as
     select t.*, now() salvo_em from public.acordos_titulos t
      where t.id in (select id from _alvo)', '_backup_pos_import_' || v_lote);
  execute format('alter table public.%I enable row level security', '_backup_pos_import_' || v_lote);

  -- o titulo que ja foi pago nao e divida: sai da conta
  update public.acordos_titulos t
     set situacao='PAGO', status='quitada',
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'')='' then '' else ' | ' end
           || 'importado em aberto, mas o extrato Santander mostra pagamento do documento '
           || t.documento,
         atualizado_em = now()
    from _pago p where p.id = t.id;
  get diagnostics v_pagos = row_count;

  -- o que e divida viva vira NEGOCIADO e ganha vinculo: a divida passa a ser
  -- contada UMA vez, pela parcela do acordo, nunca pelas duas pontas
  update public.parcelas pa set boleto = c.chave, atualizado_em = now()
    from _casa c where pa.id = c.parcela_id and pa.boleto is null;
  get diagnostics v_amarrados = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo)
  select c.acordo_id, c.titulo_id, true from _casa c
   where not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id=c.titulo_id and v.acordo_id=c.acordo_id);

  update public.acordos_titulos t
     set situacao='NEGOCIADO', status='vinculada', acordo_id = c.acordo_id, atualizado_em = now()
    from _casa c where t.id = c.titulo_id;
  get diagnostics v_vinculados = row_count;

  -- recalculo por ULTIMO
  perform public.recalcular_situacao_aluno(x.aluno_id)
     from (select aluno_id from _pago union select aluno_id from _casa) x;

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'marcados_pagos', v_pagos, 'boletos_amarrados', v_amarrados,
    'vinculados', v_vinculados, 'alunos', v_alunos,
    'backup', '_backup_pos_import_' || v_lote);
end;
$function$;

revoke all on function public.acordos_pos_importacao(uuid, boolean) from public, anon;
grant execute on function public.acordos_pos_importacao(uuid, boolean) to authenticated, service_role;
