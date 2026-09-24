-- Conferencia Prime: a validacao da gestao vira evidencia, e vale em lote.
--
-- POR QUE ESTA MIGRATION EXISTE. A Conferencia Prime foi desenhada supondo que
-- a prova viesse de fora: `baixar` exige `corroboracao = 'PAGAMENTO_REATIVA'` e
-- reconfere `prime_grupo_a_candidatos` no instante da decisao; `confirmar`
-- recusa `C_SEM_PROVA` com SEM_PROVA_DE_PAGAMENTO; `encerrar_administrativo`
-- exige `classe_humana` gravada numa chamada anterior e so aceita 2 das 7
-- classes que a propria `classificar_humano` aceita. Resultado: quem abriu o
-- Prime, olhou o titulo e SABE o que aconteceu nao tem por onde registrar isso
-- -- a unica evidencia aceita e a de maquina.
--
-- Em 24/09/2026 eram 674 titulos EM_CONFIRMACAO (R$ 1.565.480,05, 390 alunos),
-- todos com decisao PENDENTE, todos com `necessita_manual = true` na triagem
-- 2026-09-19.2, parados desde 18-19/09. Nenhuma rotina tira um titulo de la: a
-- saida e humana por desenho (`_titulo_em_confirmacao_protegido`). E a API da
-- Prime nao vai fechar essa conta -- a estrutura financeira do acordo esta
-- classificada VERMELHA em docs/integracoes/prime-gaps.md (rota nao exposta na
-- superficie publica testada). Ou seja: a decisao E da gestao, sempre foi, e o
-- sistema nao tinha onde recebe-la.
--
-- O QUE MUDA. Um verbo so, em lote, onde a CLASSE que a gestao viu no Prime
-- decide o destino do titulo:
--
--   PAGAMENTO_REAL ............... titulo vira PAGO/quitada
--   LIQUIDACAO_INSTITUCIONAL ..... titulo vira CANCELADA/cancelada
--   CANCELAMENTO_ESTORNO ......... titulo vira CANCELADA/cancelada
--   ISENCAO_FIES_BOLSA ........... titulo vira CANCELADA/cancelada
--   SUBSTITUICAO_TITULO .......... titulo vira CANCELADA/cancelada
--   ACORDO ....................... recusado: use prime_conferencia_vincular
--   INCONCLUSIVO ................. recusado: nao e decisao, deixe pendente
--
-- O QUE NAO MUDA, de proposito:
--   1. `baixar`, `confirmar`, `vincular`, `rejeitar` e `encerrar_administrativo`
--      continuam exatamente como estao. Este verbo e uma porta NOVA, nao um
--      afrouxamento das que existem -- quem quiser a prova de maquina continua
--      tendo a prova de maquina.
--   2. Dinheiro nao se move: nenhum pagamento, acordo, parcela ou vinculo e
--      criado. A trava no fim da funcao recusa a transacao inteira se isso
--      acontecer.
--   3. Tudo fica nomeado: quem decidiu, quando, o que viu no Prime, titulo a
--      titulo, em `auditoria`, `aluno_movimentacoes` e
--      `prime_liquidacao_classificacao`.
--
-- REVERSIBILIDADE. Nao ha PITR neste projeto, entao a volta precisa ser por
-- marca propria, e nao por restore. Por isso a validacao da gestao grava
-- `origem_liquidacao = 'PRIME_VALIDACAO_GESTAO'` ou
-- `origem_encerramento = 'CONFERENCIA_PRIME_VALIDACAO_GESTAO'` -- valores NOVOS,
-- distintos dos da conferencia automatica. Um lote errado se identifica por
-- essa marca + `decidido_em`, sem tocar no que a maquina decidiu.

-- As marcas novas precisam caber nos CHECKs que existem hoje.
alter table public.acordos_titulos
  drop constraint if exists acordos_titulos_origem_liquidacao_valida;
alter table public.acordos_titulos
  add constraint acordos_titulos_origem_liquidacao_valida
  check (origem_liquidacao is null
         or origem_liquidacao in ('PRIME_LIQUIDACAO_OFICIAL', 'PRIME_VALIDACAO_GESTAO'));

alter table public.acordos_titulos
  drop constraint if exists acordos_titulos_origem_encerramento_valida;
alter table public.acordos_titulos
  add constraint acordos_titulos_origem_encerramento_valida
  check (origem_encerramento is null
         or origem_encerramento in ('CONFERENCIA_PRIME_ADMINISTRATIVA',
                                    'CONFERENCIA_PRIME_VALIDACAO_GESTAO'));

create or replace function public.prime_conferencia_validar_lote(
  p_titulo_ids uuid[],
  p_classe     text,
  p_observacao text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_email    text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs      text := nullif(btrim(coalesce(p_observacao, '')), '');
  v_ids      uuid[];
  v_id       uuid;
  v_titulo   public.acordos_titulos%rowtype;
  v_dec      public.prime_conferencia_decisao%rowtype;
  v_valor    numeric;
  v_liq      text;
  v_ev       jsonb;
  v_vira_pago      boolean;
  v_classificacao  text;
  v_aplicados      jsonb := '[]'::jsonb;
  v_ignorados      jsonb := '[]'::jsonb;
  v_alunos   uuid[] := array[]::uuid[];
  v_aluno    uuid;
  v_total    numeric := 0;
  v_pag0 int; v_ac0 int; v_parc0 int; v_vinc0 int;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Validacao da Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  if p_classe is null or p_classe not in ('PAGAMENTO_REAL', 'LIQUIDACAO_INSTITUCIONAL',
                                          'CANCELAMENTO_ESTORNO', 'ISENCAO_FIES_BOLSA',
                                          'SUBSTITUICAO_TITULO') then
    if p_classe = 'ACORDO' then
      raise exception 'USE_O_VINCULO: titulo coberto por acordo se resolve em prime_conferencia_vincular, que prende o titulo ao acordo certo -- nao da para fazer isso em lote sem escolher o acordo.';
    end if;
    if p_classe = 'INCONCLUSIVO' then
      raise exception 'INCONCLUSIVO_NAO_DECIDE: se ainda esta inconclusivo, o titulo fica em confirmacao. Registre o que viu em prime_conferencia_classificar_humano.';
    end if;
    raise exception 'CLASSE_INVALIDA: %', coalesce(p_classe, 'nula');
  end if;

  -- A observacao E a evidencia: e ela que responde "por que este titulo saiu
  -- da confirmacao" em toda auditoria daqui pra frente. Por isso 15, e nao 10.
  if length(coalesce(v_obs, '')) < 15 then
    raise exception 'EVIDENCIA_OBRIGATORIA: escreva o que voce viu no Prime (minimo 15 caracteres). E isso que fica no lugar da prova automatica.';
  end if;

  select array_agg(distinct x) into v_ids from unnest(coalesce(p_titulo_ids, array[]::uuid[])) as x;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'SEM_TITULOS: informe ao menos um titulo.';
  end if;
  if cardinality(v_ids) > 100 then
    raise exception 'LOTE_GRANDE_DEMAIS: % titulos. Mande em blocos de ate 100 -- cada titulo grava movimentacao, auditoria e classificacao.', cardinality(v_ids);
  end if;

  -- PAGAMENTO_REAL vira dinheiro recebido na ficha do aluno: exige o mesmo
  -- portao das outras baixas, nao so "ser gestao".
  v_vira_pago := (p_classe = 'PAGAMENTO_REAL');
  if v_vira_pago and not coalesce(public.crm_usuario_pode_quitar_baixar(), false) then
    raise exception 'SEM_PERMISSAO: seu usuario nao pode marcar titulo como pago.' using errcode = '42501';
  end if;

  v_classificacao := case when v_vira_pago then 'PAGAMENTO_COMPROVADO' else 'LIQUIDACAO_INSTITUCIONAL' end;

  select count(*) into v_pag0  from public.pagamentos;
  select count(*) into v_ac0   from public.acordos;
  select count(*) into v_parc0 from public.parcelas;
  select count(*) into v_vinc0 from public.acordo_titulo_vinculo;

  foreach v_id in array v_ids loop
    select * into v_titulo from public.acordos_titulos where id = v_id for update;
    if not found then
      v_ignorados := v_ignorados || jsonb_build_object('titulo_id', v_id, 'motivo', 'TITULO_NAO_ENCONTRADO');
      continue;
    end if;

    if upper(coalesce(v_titulo.situacao, '')) <> 'EM_CONFIRMACAO' then
      v_ignorados := v_ignorados || jsonb_build_object('titulo_id', v_id, 'documento', v_titulo.documento,
                                                       'motivo', 'NAO_ESTA_EM_CONFIRMACAO',
                                                       'situacao', v_titulo.situacao);
      continue;
    end if;

    select * into v_dec from public.prime_conferencia_decisao where titulo_id = v_id for update;
    if not found or v_dec.decisao <> 'PENDENTE' then
      v_ignorados := v_ignorados || jsonb_build_object('titulo_id', v_id, 'documento', v_titulo.documento,
                                                       'motivo', 'SEM_DECISAO_PENDENTE',
                                                       'decisao', coalesce(v_dec.decisao, '(sem linha)'));
      continue;
    end if;

    v_valor := round(coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido,
                              v_titulo.valor_em_aberto, v_titulo.valor_original, 0), 2);
    v_liq := coalesce(v_dec.evidencia ->> 'liquidado_em', v_dec.evidencia -> 'prime' ->> 'liquidado_em', '?');

    perform set_config('conferencia_prime.decisao', 'on', true);
    if v_vira_pago then
      update public.acordos_titulos
         set situacao = 'PAGO', status = 'quitada',
             origem_liquidacao     = 'PRIME_VALIDACAO_GESTAO',
             origem_liquidacao_ref = 'conferencia_prime_validacao:' || v_id::text,
             origem_liquidacao_em  = now(),
             motivo_ajuste = coalesce(motivo_ajuste, '')
               || case when coalesce(motivo_ajuste, '') = '' then '' else ' | ' end
               || 'validado na tela do Prime pela gestao (' || p_classe || '): ' || v_obs
               || '; liquidado na Prime em ' || v_liq
               || '; por ' || coalesce(nullif(v_email, ''), 'gestao')
               || ' em ' || to_char(now(), 'DD/MM/YYYY HH24:MI'),
             atualizado_em = now()
       where id = v_id;
    else
      update public.acordos_titulos
         set situacao = 'CANCELADA', status = 'cancelada',
             origem_encerramento     = 'CONFERENCIA_PRIME_VALIDACAO_GESTAO',
             origem_encerramento_ref = 'conferencia_prime_validacao:' || v_id::text,
             origem_encerramento_em  = now(),
             motivo_ajuste = coalesce(motivo_ajuste, '')
               || case when coalesce(motivo_ajuste, '') = '' then '' else ' | ' end
               || 'validado na tela do Prime pela gestao (' || p_classe || '): ' || v_obs
               || '; liquidado na Prime em ' || v_liq
               || '; por ' || coalesce(nullif(v_email, ''), 'gestao')
               || ' em ' || to_char(now(), 'DD/MM/YYYY HH24:MI')
               || '. Sem pagamento, acordo ou recuperacao.',
             atualizado_em = now()
       where id = v_id;
    end if;
    perform set_config('conferencia_prime.decisao', 'off', true);

    update public.prime_conferencia_decisao
       set decisao           = case when v_vira_pago then 'CONFIRMADO' else 'ENCERRADO_ADMINISTRATIVO' end,
           classe_humana     = p_classe,
           classe_humana_obs = v_obs,
           classe_humana_por = nullif(v_email, ''),
           classe_humana_em  = now(),
           motivo            = 'validacao da gestao na tela do Prime: ' || v_obs,
           decidido_por      = nullif(v_email, ''),
           decidido_em       = now()
     where titulo_id = v_id;

    v_ev := public.prime_liquidacao_evidencias(v_id);
    insert into public.prime_liquidacao_classificacao
      (titulo_id, aluno_id, documento, evidencia_chave, data_liquidacao_prime, portador,
       classificacao, nivel_evidencia, motivo, evidencia, origem_decisao, decidido_por, resultado_titulo)
    values (v_id, v_titulo.aluno_id, v_titulo.documento,
            coalesce(v_ev ->> 'evidencia_chave', v_dec.evidencia_chave, '-'),
            nullif(v_liq, '?')::date, (v_ev -> 'prime' ->> 'portador')::int,
            v_classificacao, 'DOCUMENTAL',
            'validacao humana na tela do Prime (' || p_classe || '): ' || v_obs,
            coalesce(v_ev, '{}'::jsonb) || jsonb_build_object('classe_humana', p_classe,
                                                             'classe_humana_obs', v_obs,
                                                             'validacao_gestao', true),
            'GESTAO', coalesce(nullif(v_email, ''), 'gestao'),
            case when v_vira_pago then 'PAGO' else 'CANCELADA' end)
    on conflict do nothing;

    if v_titulo.aluno_id is not null then
      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
      values (v_titulo.aluno_id::text,
              case when v_vira_pago then 'TITULO_VALIDADO_PRIME_PAGO' else 'TITULO_VALIDADO_PRIME_ENCERRADO' end,
              'Titulo ' || coalesce(v_titulo.documento, '?')
                || ' (venc. ' || to_char(v_titulo.vencimento, 'DD/MM/YYYY') || ') '
                || case when v_vira_pago
                        then 'marcado como PAGO por validacao da gestao na tela do Prime'
                        else 'encerrado por validacao da gestao na tela do Prime (' || p_classe || '): a divida deixou de ser exigivel. Sem pagamento, acordo, baixa ou recuperacao' end
                || '. Liquidado na Prime em ' || v_liq || '. ' || v_obs,
              'EM_CONFIRMACAO', case when v_vira_pago then 'PAGO' else 'CANCELADA' end,
              v_email, v_email, now(), v_valor);

      if not (v_titulo.aluno_id = any(v_alunos)) then
        v_alunos := v_alunos || v_titulo.aluno_id;
      end if;
    end if;

    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (coalesce(nullif(v_email, ''), 'sistema'),
            'CONFERENCIA_PRIME_VALIDACAO_GESTAO', 'acordos_titulos', v_id,
            jsonb_build_object('documento', v_titulo.documento, 'valor', v_valor,
                               'classe_humana', p_classe, 'observacao', v_obs,
                               'subgrupo', v_dec.subgrupo, 'evidencia_deteccao', v_dec.evidencia,
                               'resultado', case when v_vira_pago then 'PAGO' else 'CANCELADA' end,
                               'origem', 'VALIDACAO_HUMANA_TELA_PRIME',
                               'lote', cardinality(v_ids)));

    v_total := v_total + v_valor;
    v_aplicados := v_aplicados || jsonb_build_object('titulo_id', v_id, 'documento', v_titulo.documento,
                                                     'valor', v_valor,
                                                     'resultado', case when v_vira_pago then 'PAGO' else 'CANCELADA' end);
  end loop;

  -- O aluno e recalculado UMA vez, no fim, e nao a cada titulo: o mesmo aluno
  -- costuma ter varios titulos no mesmo lote (a triagem contou ate 12).
  foreach v_aluno in array v_alunos loop
    perform public.recalcular_situacao_aluno(v_aluno, 'conferencia_prime_validacao_gestao');
    if not v_vira_pago then
      perform public.prime_conferencia_encerrar_zerado_aluno(v_aluno, 'conferencia_prime_validacao_gestao');
      -- Encerramento administrativo nao e quitacao: quem ficou sem saldo por
      -- este caminho e SEM_PENDENCIA, nunca QUITADO.
      update public.alunos set situacao_operacional = 'SEM_PENDENCIA', proxima_acao = null
       where id = v_aluno and situacao_operacional in ('QUITADO', 'QUITADO_AGUARDANDO_BAIXA');
      update public.casos set situacao_operacional = 'SEM_PENDENCIA', proxima_acao_automatica = null
       where aluno_id = v_aluno and situacao_operacional in ('QUITADO', 'QUITADO_AGUARDANDO_BAIXA');
    end if;
  end loop;

  if (select count(*) from public.pagamentos) <> v_pag0
     or (select count(*) from public.acordos) <> v_ac0
     or (select count(*) from public.parcelas) <> v_parc0
     or (select count(*) from public.acordo_titulo_vinculo) <> v_vinc0 then
    raise exception 'TRAVA: validacao da gestao criou pagamento/acordo/parcela/vinculo -- nenhuma das duas decisoes move dinheiro.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'classe', p_classe,
    'resultado', case when v_vira_pago then 'PAGO' else 'CANCELADA' end,
    'aplicados', jsonb_array_length(v_aplicados),
    'ignorados', jsonb_array_length(v_ignorados),
    'valor_total', round(v_total, 2),
    'alunos_recalculados', cardinality(v_alunos),
    'detalhe_aplicados', v_aplicados,
    'detalhe_ignorados', v_ignorados,
    'efeito_financeiro', case when v_vira_pago then 'titulo marcado como pago; nenhum pagamento criado' else 'nenhum' end
  );
end;
$function$;

comment on function public.prime_conferencia_validar_lote(uuid[], text, text) is
  'Conferencia Prime: aplica em lote a decisao que a gestao tomou olhando a tela do Prime. A classe decide o destino (PAGAMENTO_REAL -> PAGO; institucionais -> CANCELADA). A observacao e a evidencia e fica em auditoria, movimentacao e prime_liquidacao_classificacao. Marca propria (PRIME_VALIDACAO_GESTAO / CONFERENCIA_PRIME_VALIDACAO_GESTAO) para reverter em bloco sem tocar no que a maquina decidiu.';

revoke all on function public.prime_conferencia_validar_lote(uuid[], text, text) from public;
grant execute on function public.prime_conferencia_validar_lote(uuid[], text, text) to authenticated;
