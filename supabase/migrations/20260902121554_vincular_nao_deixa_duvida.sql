-- Vincular para de morrer no limite de 8s -- e repetir vira operacao segura.
--
-- Amanda, 02/09: "erro ao vincular parcela", "preciso vincular, todos os dias o
-- sistema apresenta esse erro", "eu nao quero ter que voltar aos casos que ja
-- foram feitos".
--
-- O QUE ACONTECIA. `vincular_titulos_acordo` serializa por acordo com
-- `pg_advisory_xact_lock`. O botao da ficha nao travava o clique, entao cada
-- clique disparava outra chamada para o MESMO acordo. A primeira segurava o
-- cadeado; as seguintes ficavam na fila e morriam no statement_timeout de 8s do
-- PostgREST. A tela dizia "Erro ao vincular" -- e o vinculo tinha sido gravado.
--
-- MEDIDO EM PROD (02/09, acordo 4408, Everton Alves Cardoso):
--   14 respostas 500 entre 12:02 e 12:04, todas "canceling statement due to
--   statement timeout", com processos esperando 7,8s no mesmo advisory lock.
--   As 2 mensalidades FORAM vinculadas -- auditoria as 12:05:23.
--   Nas mesmas 24h: 120 chamadas com sucesso, e as 14 falhas todas nesses 2 min.
--
-- TRES MUDANCAS, nenhuma delas mexe em dado existente:
--
-- 1. `statement_timeout` de 60s na propria funcao. O trabalho leva ~110ms; o
--    que estourava era a ESPERA na fila. Com o limite proprio, a chamada que
--    esperou termina em vez de ser morta no meio.
--
-- 2. `pg_try_advisory_xact_lock` no lugar do `pg_advisory_xact_lock`. Se outra
--    chamada esta com o mesmo acordo, esta volta NA HORA com ACORDO_EM_USO --
--    e volta ANTES de escrever qualquer coisa. Nao ha duvida sobre o que foi
--    gravado: nada foi.
--
-- 3. Repetir passa a ser seguro. Titulo que JA esta neste mesmo acordo deixa de
--    ser recusado como "inelegivel": ele conta em `ja_estavam` e a funcao
--    devolve ok. Assim, clicar de novo depois de um erro responde "ja estavam
--    vinculadas" em vez de um erro novo -- ninguem precisa voltar no caso para
--    conferir na mao.
--
--    O que continua bloqueado, sem excecao: titulo de OUTRO acordo, de OUTRO
--    aluno, quitado/cancelado, DUPLICADA, e saldo zerado sem ser negociado.
--
-- DESFAZER: supabase/rollbacks/20260902160000_vincular_nao_deixa_duvida.rollback.sql

create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_numero text;
  v_quitado boolean;
  v_bloqueados uuid[];
  v_novos uuid[];
  v_ja int := 0;
  v_n int := 0;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  -- Cadeado sem fila: se o acordo esta em uso, volta agora, sem ter escrito
  -- nada. Antes esperava e morria nos 8s -- sem saber se gravou ou nao.
  if not pg_try_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0)) then
    return jsonb_build_object('ok',false,'erro','ACORDO_EM_USO');
  end if;

  select aluno_id, upper(coalesce(status,'')), coalesce(numero_acordo::text,'')
    into v_aluno_acordo, v_status_acordo, v_numero
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  -- Ja esta neste mesmo acordo: nao e erro, e trabalho ja feito.
  -- `coalesce` obrigatorio: em titulo sem acordo, `t.acordo_id = p_acordo_id` da
  -- NULL (nao `false`), e `not NULL` e NULL -- a linha sumia da lista de novos e
  -- a funcao respondia "0 vinculados" sem vincular nada. Pego no teste.
  select count(*) into v_ja
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and coalesce(
          t.aluno_id = v_aluno_acordo
          and (coalesce(t.acordo_id = p_acordo_id, false)
               or exists (select 1 from public.acordo_titulo_vinculo v
                           where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                             and coalesce(v.ativo,true)))
        , false);

  select array_agg(t.id) into v_novos
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not coalesce(
          t.aluno_id = v_aluno_acordo
          and (coalesce(t.acordo_id = p_acordo_id, false)
               or exists (select 1 from public.acordo_titulo_vinculo v
                           where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                             and coalesce(v.ativo,true)))
        , false);

  if v_novos is null or array_length(v_novos,1) is null then
    -- tudo que veio ja estava vinculado a este acordo
    return jsonb_build_object('ok', true, 'vinculados', 0, 'ja_estavam', v_ja,
                              'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo);
  end if;

  -- mesmo cuidado com NULL aqui: titulo sem aluno_id daria NULL e escaparia da
  -- lista de bloqueados em vez de ser barrado.
  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(v_novos)
    and not coalesce(
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and lower(coalesce(t.status,'')) not in
            ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
      and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
      and (
            coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
        or upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
      )
    , false);

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object('ok',false,'erro','PARCELAS_INELEGIVEIS',
                              'bloqueados', to_jsonb(v_bloqueados), 'ja_estavam', v_ja);
  end if;

  -- O estado da mensalidade segue o acordo (20260902140000): acordo pago deixa
  -- a mensalidade quitada; acordo ativo deixa negociada.
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
     where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
  else
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
  end if;
  get diagnostics v_n = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n, 'ja_estavam', v_ja,
                             'status_acordo', v_status_acordo,
                             'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end,
                             'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'ja_estavam', v_ja,
                            'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo,
                            'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end);
end;
$function$;
