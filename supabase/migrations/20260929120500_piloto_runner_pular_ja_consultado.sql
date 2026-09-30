-- RUNNER DO PILOTO -- pula quem a ficha já consultou, e conta as requisições
-- ============================================================================
--
-- Duas peças que faltavam para o lote andar sozinho depois de um clique:
--
--   1. a consulta precisa gravar QUANTAS requisições gastou (paginação conta);
--   2. antes de cada chamada, quem já foi consultado PELA FICHA desde que o
--      lote foi preparado tem de ser pulado -- senão o piloto gasta requisição
--      para refazer o que a tela já trouxe.
--
-- O segundo ponto não é hipótese: a consulta automática da ficha está viva e,
-- entre preparar o lote e processá-lo, a gestão continua abrindo fichas.

-- ---------------------------------------------------------------------------
-- 1. `requisicoes` na gravação da consulta
-- ---------------------------------------------------------------------------
-- Recriada com o parâmetro no fim e com DEFAULT: as chamadas que passam os 9
-- argumentos nomeados continuam resolvendo, então a função implantada não
-- quebra enquanto o deploy novo não sobe.
drop function if exists public.prime_academico_registrar(uuid,text,text,text,text,integer,integer,jsonb,text);

create or replace function public.prime_academico_registrar(
  p_aluno_id      uuid,
  p_cpf           text,
  p_registration  text,
  p_resultado     text,
  p_detalhe_falha text,
  p_http_status   integer,
  p_total_items   integer,
  p_vinculos      jsonb,
  p_email         text,
  p_requisicoes   integer default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Acesso negado: apenas service_role.' using errcode = '42501';
  end if;

  if p_resultado not in ('COM_VINCULOS','SEM_RESULTADO',
                         'PAGINACAO_INCOMPLETA','FALHA_COMUNICACAO') then
    raise exception 'resultado invalido: %', p_resultado using errcode = '22023';
  end if;

  -- FALHA NÃO APAGA O QUE JÁ SE SABIA. Cada consulta é uma linha nova; a
  -- leitura pega a mais recente e, quando ela falhou, também a última completa.
  insert into public.prime_academico_consulta
    (aluno_id, cpf, registration, resultado, detalhe_falha, http_status, total_items,
     consultado_por_email, requisicoes)
  values
    (p_aluno_id, p_cpf, nullif(p_registration,''), p_resultado,
     nullif(p_detalhe_falha,''), p_http_status, p_total_items, nullif(p_email,''),
     greatest(coalesce(p_requisicoes, 1), 1))
  returning id into v_id;

  -- PAGINACAO_INCOMPLETA também grava as linhas: o dado parcial é dado, e
  -- jogá-lo fora deixaria a tela sem nada tendo o que mostrar.
  if p_resultado in ('COM_VINCULOS','PAGINACAO_INCOMPLETA')
     and jsonb_typeof(p_vinculos) = 'array' then
    insert into public.prime_academico_vinculo
      (consulta_id, ordem, registration, curso, campus, turno, status, admission_year, graduated)
    select
      v_id, (t.ord)::int,
      nullif(t.item->>'registration',''),
      nullif(t.item->>'course',''),
      nullif(t.item->>'campus',''),
      nullif(t.item->>'shift',''),
      nullif(t.item->>'status',''),
      case when jsonb_typeof(t.item->'admissionYear') = 'number'
           then (t.item->>'admissionYear')::int end,
      case when jsonb_typeof(t.item->'graduated') = 'boolean'
           then (t.item->>'graduated')::boolean end
    from jsonb_array_elements(p_vinculos) with ordinality as t(item, ord);
  end if;

  return v_id;
end;
$$;

revoke all on function public.prime_academico_registrar(uuid,text,text,text,text,integer,integer,jsonb,text,integer)
  from public, anon, authenticated;
grant execute on function public.prime_academico_registrar(uuid,text,text,text,text,integer,integer,jsonb,text,integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. PRÓXIMO -- agora pula quem a ficha já consultou
-- ---------------------------------------------------------------------------
-- Deixou de ser `stable` porque agora ESCREVE: marca como PULADO, antes de
-- devolver qualquer item, todo pendente cujo aluno já tenha consulta. A fila
-- foi montada só com "Ainda não consultados"; se um deles já tem consulta
-- agora, foi a ficha que consultou no meio do caminho -- e refazer gastaria
-- requisição para trazer o que já está no banco.
--
-- O pulo é registrado (estado PULADO, com motivo), não some: quem olhar o
-- painel depois precisa conseguir explicar por que o lote de 100 fez 87
-- chamadas.
drop function if exists public.prime_academico_piloto_proximo(uuid);

create or replace function public.prime_academico_piloto_proximo(p_lote uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_lote public.prime_academico_piloto_lote;
  v_gastas integer;
  v_pulados integer;
  v_item public.prime_academico_piloto_item;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  select * into v_lote from public.prime_academico_piloto_lote where id = p_lote;
  if v_lote.id is null then
    return jsonb_build_object('parar', true, 'motivo', 'lote inexistente');
  end if;
  if v_lote.estado in ('CONCLUIDO','INTERROMPIDO') then
    return jsonb_build_object('parar', true, 'motivo', coalesce(v_lote.motivo, v_lote.estado));
  end if;

  -- PULA QUEM A FICHA JÁ CONSULTOU.
  update public.prime_academico_piloto_item i
     set estado = 'PULADO',
         erro = 'ja consultado pela ficha depois de o lote ser preparado',
         requisicoes = 0,
         processado_em = now()
   where i.lote_id = p_lote
     and i.estado = 'PENDENTE'
     and exists (select 1 from public.prime_academico_consulta c where c.aluno_id = i.aluno_id);
  get diagnostics v_pulados = row_count;

  select coalesce(sum(requisicoes), 0) into v_gastas
    from public.prime_academico_piloto_item where lote_id = p_lote;
  if v_gastas >= v_lote.limite_requisicoes then
    update public.prime_academico_piloto_lote
       set estado = 'INTERROMPIDO', encerrado_em = now(),
           motivo = 'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes
     where id = p_lote;
    return jsonb_build_object('parar', true, 'pulados_agora', v_pulados,
      'motivo', 'teto de requisicoes atingido: ' || v_gastas || ' de ' || v_lote.limite_requisicoes);
  end if;

  select * into v_item from public.prime_academico_piloto_item
   where lote_id = p_lote and estado = 'PENDENTE' order by ordem limit 1;

  if v_item.id is null then
    update public.prime_academico_piloto_lote
       set estado = 'CONCLUIDO', encerrado_em = now() where id = p_lote and estado <> 'INTERROMPIDO';
    return jsonb_build_object('parar', true, 'pulados_agora', v_pulados, 'motivo', 'fila vazia');
  end if;

  update public.prime_academico_piloto_lote
     set estado = 'EM_ANDAMENTO' where id = p_lote and estado = 'PRONTO';

  return jsonb_build_object(
    'parar', false, 'item_id', v_item.id, 'aluno_id', v_item.aluno_id, 'ordem', v_item.ordem,
    'pulados_agora', v_pulados,
    'requisicoes_gastas', v_gastas, 'limite_requisicoes', v_lote.limite_requisicoes);
end;
$$;

revoke all on function public.prime_academico_piloto_proximo(uuid) from public, anon;
grant execute on function public.prime_academico_piloto_proximo(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. PAUSAR / RETOMAR, explícitos
-- ---------------------------------------------------------------------------
-- Pausa é do LOTE, não da aba: fechar o navegador no meio não deixa o lote
-- "rodando" para sempre, e retomar de outro lugar continua de onde parou.
-- Retomar um lote INTERROMPIDO por 401/403/429 é decisão humana -- por isso
-- exige passar `p_forcar`, que é o jeito de dizer "eu sei o que aconteceu".
create or replace function public.prime_academico_piloto_pausar(p_lote uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;
  update public.prime_academico_piloto_lote
     set estado = 'PRONTO' where id = p_lote and estado = 'EM_ANDAMENTO';
  return jsonb_build_object('ok', found);
end;
$$;

create or replace function public.prime_academico_piloto_retomar(p_lote uuid, p_forcar boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare v_estado text; v_motivo text;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;
  select estado, motivo into v_estado, v_motivo
    from public.prime_academico_piloto_lote where id = p_lote;

  if v_estado = 'INTERROMPIDO' and not coalesce(p_forcar, false) then
    return jsonb_build_object('ok', false, 'motivo', coalesce(v_motivo, 'lote interrompido'),
      'aviso', 'lote interrompido pela API; retomar exige decisao explicita');
  end if;
  if v_estado = 'CONCLUIDO' then
    return jsonb_build_object('ok', false, 'motivo', 'lote concluido');
  end if;

  update public.prime_academico_piloto_lote
     set estado = 'EM_ANDAMENTO', motivo = null, encerrado_em = null where id = p_lote;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.prime_academico_piloto_pausar(uuid) from public, anon;
revoke all on function public.prime_academico_piloto_retomar(uuid, boolean) from public, anon;
grant execute on function public.prime_academico_piloto_pausar(uuid) to authenticated, service_role;
grant execute on function public.prime_academico_piloto_retomar(uuid, boolean) to authenticated, service_role;
