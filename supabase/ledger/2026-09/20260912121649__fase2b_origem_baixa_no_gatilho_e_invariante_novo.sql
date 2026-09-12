-- O gatilho de baixa na importacao passa a declarar a origem.
-- `confirmado_por_email` CONTINUA sendo gravado de proposito: `baixa_sem_lastro`
-- e `baixas_sem_lastro_excluir` usam `confirmado_por_email is null` como filtro,
-- e pararem de receber a assinatura mudaria o comportamento deles. A migracao
-- desse filtro para `origem_baixa` e um passo separado, a combinar.
create or replace function public._pagamento_baixa_pelo_documento()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_chave text; v_parcela record; v_venc date;
begin
  v_chave := ltrim(coalesce(new.numero_parcela_completo,''),'0');
  if v_chave = '' then return new; end if;
  v_venc := public.vencimento_do_pagamento(new.dados);

  select p.id, p.valor, p.status, p.honorarios, p.acordo_id, p.vencimento, p.numero, a.aluno_id, a.status status_acordo
    into v_parcela
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where p.boleto = v_chave limit 1;

  if not found then return new; end if;
  if v_parcela.status = 'PAGO' then return new; end if;
  if upper(coalesce(v_parcela.status_acordo,'')) <> 'ATIVO' then return new; end if;

  if new.valor_pago < v_parcela.valor - 0.05
     or new.valor_pago > v_parcela.valor * 1.15 then
    return new;
  end if;

  if not public.documento_casa_com_parcela(v_parcela.id, v_venc) then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina', 'BAIXA_DOCUMENTO_RECUSADA', 'parcelas', v_parcela.id,
            jsonb_build_object('pagamento_id', new.id, 'documento', v_chave,
                               'vencimento_extrato', v_venc, 'parcela_numero', v_parcela.numero,
                               'parcela_vencimento', v_parcela.vencimento, 'valor_pago', new.valor_pago,
                               'motivo', case when v_venc is not null then 'vencimento do extrato nao bate com a parcela do boleto'
                                              else 'ha parcela mais antiga em aberto no acordo' end));
    return new;
  end if;

  update public.parcelas
     set status = 'PAGO', pago_em = new.data_pagamento,
         confirmado_por_email = coalesce(new.operador_email,'extrato_santander'),
         -- NOVO: a origem fica explicita, com o evento que a gerou.
         origem_baixa = 'GATILHO_IMPORTACAO',
         origem_baixa_ref = new.id::text,
         origem_baixa_em = now(),
         honorarios = case when coalesce(honorarios,0) = 0 and coalesce(new.valor_honorario,0) > 0
                           then new.valor_honorario else honorarios end,
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'baixa automatica na importacao: documento ' || v_chave
           || ' pago em ' || to_char(new.data_pagamento,'DD/MM/YYYY')
           || case when v_venc is not null then ' (vencimento ' || to_char(v_venc,'DD/MM/YYYY') || ' conferido)' else '' end,
         atualizado_em = now()
   where id = v_parcela.id;

  perform public.recalcular_situacao_aluno(v_parcela.aluno_id);
  return new;
end;
$fn$;

-- ------------------------------------------------------------
-- Invariante novo, com evidencia real de autoria.
-- ------------------------------------------------------------
insert into public.invariante_config (nome, ligado, severidade, titulo, explicacao)
values ('baixa_sem_evidencia_de_quem_baixou', true, 'GRAVE',
        'Baixa sem evidencia de quem baixou',
        'Parcela PAGO, boleto de 11 digitos, sem pagamento do proprio boleto E sem nenhuma evidencia de autoria: '
        || 'sem origem_baixa, sem registro em baixas_pagamento com responsavel, sem marcador de rotina na observacao '
        || 'e sem linha em auditoria. Substitui baixa_manual_na_parcela_errada, que usava confirmado_por_email como '
        || 'prova de acao humana -- e o gatilho de importacao tambem grava ali, entao aquela regra nao separava '
        || 'humano de rotina.')
on conflict (nome) do update set ligado = true, explicacao = excluded.explicacao;

update public.invariante_config
   set ligado = false,
       explicacao = coalesce(explicacao,'')
         || ' [DESLIGADO 12/09/2026: usava confirmado_por_email como prova de acao humana, mas o gatilho de '
         || 'importacao grava extrato_santander ali. Substituido por baixa_sem_evidencia_de_quem_baixou.]'
 where nome = 'baixa_manual_na_parcela_errada';

-- Substituicao CIRURGICA no corpo do vigia: insere o novo `when` imediatamente
-- antes do `else`, mantendo todo o resto byte a byte identico.
do $cirurgia$
declare v_src text; v_novo text; v_branch text; v_marcador text := E'      else v_n := 0;';
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='invariantes_rodar';

  if position(v_marcador in v_src) = 0 then
    raise exception 'marcador "else v_n := 0;" nao encontrado -- abortando sem tocar a funcao';
  end if;
  if position('baixa_sem_evidencia_de_quem_baixou'' then' in v_src) > 0 then
    raise notice 'ramo ja existe; nada a fazer'; return;
  end if;

  v_branch := E'
      -- Autoria REAL da baixa. confirmado_por_email nao serve: o gatilho de
      -- importacao grava extrato_santander ali. Evidencia valida e
      -- origem_baixa, ou baixas_pagamento com responsavel, ou marcador de
      -- rotina na observacao, ou linha em auditoria.
      when ''baixa_sem_evidencia_de_quem_baixou'' then
        select count(*), round(coalesce(sum(p.valor),0),2) into v_n, v_v
          from public.parcelas p
         where p.status = ''PAGO''
           and p.boleto is not null and length(p.boleto) = 11
           and p.origem_baixa is null
           and not exists (select 1 from public.pagamentos g
                            where g.numero_parcela_completo = p.boleto)
           and not exists (select 1 from public.baixas_pagamento b
                            where b.parcela_id = p.id
                              and nullif(b.baixado_por_email,'''') is not null)
           and coalesce(p.observacao,'''') !~ ''baixa automatica na importacao''
           and coalesce(p.confirmado_por_email,'''') <> ''extrato_santander''
           and not exists (select 1 from public.auditoria au
                            where au.tabela_afetada = ''parcelas'' and au.registro_id = p.id);

';

  v_novo := replace(v_src, v_marcador, v_branch || v_marcador);

  execute format(
    'create or replace function public.invariantes_rodar(p_nome text default null::text)
       returns table(nome text, achados bigint, valor numeric)
       language plpgsql security definer
       set search_path to ''public'', ''cron''
       as %s', quote_literal(v_novo));
end
$cirurgia$;

revoke all on function public.invariantes_rodar(text) from public, anon, authenticated;
