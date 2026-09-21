-- CONFIRMACAO PROCESSADA: RESOLVER + PROVA (Bloco 1b/1c) -- SOMENTE LEITURA, nenhuma escrita em dado de negocio.
--
--  confirmacao_utc_provada()              prova de fuso para a chave legada (fail closed)
--  confirmacao_pagamentos_resolver(id)    VINCULO_GRAVADO | CHAVE_MESMA_TRANSACAO | AMBIGUO | SEM_VINCULO
--  confirmacao_pagamento_processado(id)   PROCESSADO | NAO_PROCESSADO | REVISAO (grupo parcial / ambiguo)
--
-- Regras: vinculo AUSENTE => SEM_VINCULO (fluxo manual atual, nunca bloqueia); AMBIGUO/parcial => REVISAO; nunca infere processamento sem
-- prova: BAIXADO + parcela com boleto exato PAGO + origem_baixa_ref = pagamento.id, para TODOS os pagamentos. Baixa em baixas_pagamento
-- sem origem_baixa_ref NAO prova. A chave legada compara created_at (timestamp SEM fuso) com criado_em AT TIME ZONE 'UTC' e so vale
-- quando confirmacao_utc_provada() (sessao em UTC E amostra do import casando em UTC e em nenhum outro fuso); senao SEM_VINCULO.
begin;

CREATE OR REPLACE FUNCTION public._nome_norm(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  select translate(upper(regexp_replace(trim(coalesce(p,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') $f$;

-- Prova de fuso para a chave legada. created_at e `timestamp` sem fuso (now() na sessao do import); criado_em e timestamptz.
-- Provada = sessao em UTC E amostra (import dos ultimos 30 dias) com >= N confirmacoes casando em UTC e NENHUMA casando so em outro fuso.
CREATE OR REPLACE FUNCTION public.confirmacao_utc_provada(p_min int DEFAULT NULL)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_min int; n_utc int; n_out int;
begin
  v_min := coalesce(p_min, (select nullif(valor->>'n','')::int from public.calibragem_parametros where chave = 'confirmacao_utc_min'), 3);
  if current_setting('TimeZone') not in ('UTC','Etc/UTC') then return false; end if;
  select count(distinct s.id) filter (where g.created_at = (s.criado_em at time zone 'UTC')),
         count(distinct s.id) filter (where g.created_at <> (s.criado_em at time zone 'UTC')
                                        and g.created_at = (s.criado_em at time zone 'America/Sao_Paulo'))
    into n_utc, n_out
    from public.solicitacoes_confirmacao_pagamento s
    join public.pagamentos g on g.data_pagamento = s.data_pagamento and public._nome_norm(g.aluno_nome) = public._nome_norm(s.aluno_nome)
   where s.motivo = 'Gerado do import de pagamentos Santander' and s.criado_em > now() - interval '30 days';
  return coalesce(n_utc,0) >= v_min and coalesce(n_out,0) = 0;
end;
$function$;

-- Resolve o conjunto de pagamentos de uma confirmacao. SOMENTE LEITURA.
-- Prova: VINCULO_GRAVADO | CHAVE_MESMA_TRANSACAO | AMBIGUO | SEM_VINCULO.
-- A chave NUNCA e so aluno/data/valor: exige criado_em da confirmacao = created_at do pagamento (mesma transacao)
-- + mesma data + mesmo nome normalizado do aluno da confirmacao + soma(valor_pago) do conjunto = valor_informado (+-0,01)
-- + todos os pagamentos com aluno_id = aluno da confirmacao + nenhum conjunto concorrente (outra transacao) que tambem feche a soma.
CREATE OR REPLACE FUNCTION public.confirmacao_pagamentos_resolver(p_confirmacao_id uuid)
 RETURNS TABLE(pagamento_id uuid, prova text, motivo text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  s record; v_nome text; v_ids uuid[]; v_soma numeric; v_n int; v_alien int; v_conc int; v_nulo int;
begin
  select * into s from public.solicitacoes_confirmacao_pagamento where id = p_confirmacao_id;
  if not found then
    return query select null::uuid, 'SEM_VINCULO'::text, 'confirmacao inexistente'::text; return;
  end if;
  if nullif(s.aluno_id,'') is null or s.data_pagamento is null or s.valor_informado is null then
    return query select null::uuid, 'SEM_VINCULO'::text, 'confirmacao sem aluno, data ou valor'::text; return;
  end if;

  -- 1) vinculo gravado (futuro)
  if to_regclass('public.solicitacao_confirmacao_pagamentos') is not null then
    execute 'select array_agg(l.pagamento_id), round(sum(coalesce(g.valor_pago,0)),2),
                    count(*) filter (where g.aluno_id is distinct from $2::uuid)
               from public.solicitacao_confirmacao_pagamentos l join public.pagamentos g on g.id = l.pagamento_id
              where l.confirmacao_id = $1'
      into v_ids, v_soma, v_alien using p_confirmacao_id, s.aluno_id;
    if v_ids is not null then
      if abs(v_soma - s.valor_informado) <= 0.01 and v_alien = 0 then
        return query select x, 'VINCULO_GRAVADO'::text, null::text from unnest(v_ids) x; return;
      end if;
      return query select null::uuid, 'AMBIGUO'::text,
        ('vinculo gravado nao confere: soma ' || v_soma || ' x valor ' || s.valor_informado || '; pagamentos de outro aluno: ' || v_alien)::text;
      return;
    end if;
  end if;

  -- 2) chave da mesma transacao (LEGADO). So vale com o fuso PROVADO; senao falha fechada.
  if not public.confirmacao_utc_provada() then
    return query select null::uuid, 'SEM_VINCULO'::text, 'legado sem vinculo gravado e fuso UTC nao provado (falha fechada)'::text; return;
  end if;
  select public._nome_norm(a.nome) into v_nome from public.alunos a where a.id = nullif(s.aluno_id,'')::uuid;
  if v_nome is null or v_nome = '' then
    return query select null::uuid, 'SEM_VINCULO'::text, 'aluno da confirmacao sem nome'::text; return;
  end if;

  select array_agg(g.id order by g.id), round(sum(coalesce(g.valor_pago,0)),2), count(*),
         count(*) filter (where g.aluno_id is distinct from nullif(s.aluno_id,'')::uuid)
    into v_ids, v_soma, v_n, v_alien
    from public.pagamentos g
   where g.created_at = (s.criado_em at time zone 'UTC')
     and g.data_pagamento = s.data_pagamento
     and public._nome_norm(g.aluno_nome) = v_nome;

  if v_n = 0 then
    return query select null::uuid, 'SEM_VINCULO'::text, 'nenhum pagamento da mesma transacao/data/nome'::text; return;
  end if;
  if abs(v_soma - s.valor_informado) > 0.01 then
    return query select null::uuid, 'AMBIGUO'::text,
      ('a soma dos pagamentos da mesma transacao (' || v_soma || ') nao confere com o valor da confirmacao (' || s.valor_informado || ')')::text; return;
  end if;
  if v_alien > 0 then
    return query select null::uuid, 'AMBIGUO'::text, (v_alien || ' pagamento(s) do conjunto nao pertencem ao aluno da confirmacao')::text; return;
  end if;
  -- conjunto concorrente: outra transacao, mesma data e nome, cuja soma tambem fecha o valor
  select count(*) into v_conc from (
    select g.created_at from public.pagamentos g
     where g.created_at <> (s.criado_em at time zone 'UTC') and g.data_pagamento = s.data_pagamento
       and public._nome_norm(g.aluno_nome) = v_nome
     group by g.created_at having abs(round(sum(coalesce(g.valor_pago,0)),2) - s.valor_informado) <= 0.01) q;
  if v_conc > 0 then
    return query select null::uuid, 'AMBIGUO'::text, (v_conc || ' outro(s) conjunto(s) de pagamentos (outra transacao) tambem fecha(m) o valor da confirmacao')::text; return;
  end if;
  return query select x, 'CHAVE_MESMA_TRANSACAO'::text, null::text from unnest(v_ids) x;
end;
$function$;

-- SOMENTE LEITURA. estado: PROCESSADO | NAO_PROCESSADO | REVISAO. Nunca escreve.
CREATE OR REPLACE FUNCTION public.confirmacao_pagamento_processado(p_confirmacao_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_prova text; v_motivo text; v_ids uuid[]; v_n int; v_ok int; v_falta jsonb := '[]'::jsonb; v_prov jsonb := '[]'::jsonb; g record; pc record;
begin
  select min(r.prova), min(r.motivo), array_agg(r.pagamento_id) filter (where r.pagamento_id is not null)
    into v_prova, v_motivo, v_ids
    from public.confirmacao_pagamentos_resolver(p_confirmacao_id) r;
  v_prova := coalesce(v_prova, 'SEM_VINCULO');

  if v_prova = 'AMBIGUO' then
    return jsonb_build_object('estado','REVISAO','prova',v_prova,'motivo',v_motivo,'pagamentos','[]'::jsonb);
  elsif v_prova = 'SEM_VINCULO' then
    return jsonb_build_object('estado','NAO_PROCESSADO','prova',v_prova,'motivo',v_motivo,'pagamentos','[]'::jsonb);
  end if;

  v_n := coalesce(array_length(v_ids,1),0); v_ok := 0;
  for g in select * from public.pagamentos where id = any(v_ids) order by id loop
    select p.id, p.status, p.origem_baixa_ref, p.boleto into pc
      from public.parcelas p
     where p.boleto = ltrim(coalesce(g.numero_parcela_completo,''),'0') and ltrim(coalesce(g.numero_parcela_completo,''),'0') <> '' limit 1;
    if coalesce(g.status_conciliacao,'') = 'BAIXADO' and pc.id is not null
       and upper(coalesce(pc.status,'')) = 'PAGO' and coalesce(pc.origem_baixa_ref,'') = g.id::text then
      v_ok := v_ok + 1;
      v_prov := v_prov || jsonb_build_object('pagamento_id', g.id, 'provado', true);
    else
      v_falta := v_falta || jsonb_build_object('pagamento_id', g.id, 'status_conciliacao', g.status_conciliacao,
                   'parcela_id', pc.id, 'parcela_status', pc.status, 'origem_baixa_ref', pc.origem_baixa_ref);
    end if;
  end loop;

  if v_n >= 2 and v_ok > 0 and v_ok < v_n then
    -- V4: grupo PARCIALMENTE processado = excecao/revisao (nunca fluxo normal, nunca 2a baixa, nunca reverter)
    return jsonb_build_object('estado','REVISAO','prova',v_prova,'motivo','GRUPO_PARCIALMENTE_PROCESSADO',
             'pagamentos',to_jsonb(v_ids),'processados',v_ok,'total',v_n,'provas_por_pagamento',v_prov || v_falta);
  end if;
  if v_n > 0 and v_ok = v_n then
    return jsonb_build_object('estado','PROCESSADO','prova',v_prova,'pagamentos',to_jsonb(v_ids),'motivo',null);
  end if;
  return jsonb_build_object('estado','NAO_PROCESSADO','prova',v_prova,'pagamentos',to_jsonb(v_ids),
           'motivo','nem todos os pagamentos do conjunto estao baixados com parcela PAGO pelo proprio pagamento','faltando',v_falta);
end;
$function$;

commit;
