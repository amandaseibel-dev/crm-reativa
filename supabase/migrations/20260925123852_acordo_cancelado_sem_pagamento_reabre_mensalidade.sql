-- ACORDO CANCELADO SEM NENHUM PAGAMENTO DEVOLVE A MENSALIDADE PARA ABERTO.
--
-- REGRA DE NEGOCIO (Amanda, 25/09/2026): "acordos com mensalidades vinculadas
-- automaticamente, quando o acordo e cancelado por falta de pagamento as
-- mensalidades devem voltar para negociacao e nao esta acontecendo, esta
-- ficando vinculadas ao antigo acordo e o status como negociado".
--
-- AJUSTA a regra de 22/09/2026 (20260922265000, aplicada como versao
-- 20260922181141), que segurava como NEGOCIADO a mensalidade de QUALQUER
-- acordo cancelado. Aquela regra existe por causa do re-acordo pelo saldo
-- residual (20260922270000/275000): quando o acordo cancelado chegou a receber
-- dinheiro, a divida passa a ser o saldo DO ACORDO, e reabrir a mensalidade
-- pelo valor cheio cobraria de novo o que ja entrou. Isso continua valendo.
--
-- O que muda: acordo que caiu SEM NENHUM pagamento em toda a cadeia da
-- mensalidade nao negociou nada de fato, e nao ha residual a proteger (o
-- residual seria o valor inteiro do acordo). Ai a mensalidade volta para
-- ABERTO/em_aberto com acordo_id nulo, livre para um acordo novo -- o caminho
-- "sem acordo vivo" de titulo_reavaliar, que ja existia.
--
-- "Pagamento" = parcela PAGO ou baixa viva (baixas_pagamento.devolvido_em
-- nulo) -- exatamente as duas travas de cancelar_acordo_ficha. Consequencia:
-- TODO cancelamento pelo botao "Cancelar acordo" da ficha (a RPC recusa acordo
-- com parcela paga ou baixa viva) devolve a mensalidade, a menos que ela tenha
-- vindo de um re-acordo cujo acordo ANTERIOR recebeu dinheiro. Por isso a
-- cadeia inteira e olhada (todo vinculo do titulo, ativo ou nao, mais o
-- acordo_id que ele guarda), nao so o ultimo acordo.
--
-- MEDIDO EM PRODUCAO ANTES DE ESCREVER (25/09/2026, somente leitura):
--   - 20 mensalidades NEGOCIADO sem vinculo vivo; 19 caem na regra nova
--     (12 acordos cancelados entre 22/09 18:21 e 25/09 11:58 UTC, 12 alunos,
--     R$ 8.457,59 de valor original, 0 parcela paga em todos, vinculos
--     EXATO_PRIME_195 / vinculo-automatico@sistema / manual, todos inativos);
--   - a 20a (R$ 428,72) tem pagamento na cadeia (acordo_id em acordo ATIVO
--     pago, vinculo so na duplicata cancelada) e continua como esta;
--   - saldo canonico (aluno_saldo_pendente_detalhe) NAO muda: NEGOCIADO sem
--     vinculo vivo ja entra como titulos_negociados_orfaos; passa a entrar
--     como titulos_abertos, mesmo valor;
--   - prime_vincular_por_negociacao so casa acordo ATIVO/QUITADO: mensalidade
--     reaberta nao volta a ser amarrada no acordo cancelado.
--
-- O QUE ESTA MIGRATION NAO FAZ: nao corrige as 19 mensalidades ja presas (a
-- regra so age quando o titulo e reavaliado -- correcao de dado separada, em
-- supabase/aguardando_aprovacao/), nao mexe em titulos_por_status_acordo, em
-- vincular_titulos_acordo nem em acordo_saldo_residual, nao muda RLS nem ACL.
-- Os corpos abaixo partem, byte a byte, de producao em 25/09/2026:
--   titulo_reavaliar       md5(prosrc) 5704f3aa88cbd1856480dbefac3f9807
--   cancelar_acordo_ficha  md5(prosrc) 6cc366f032b76fa9e0fca15d08db9964
-- titulo_reavaliar troca so o guarda do NEGOCIADO; cancelar_acordo_ficha troca
-- so o comentario interno (o codigo, sem comentarios, e identico -- provado
-- em supabase/tests/acordo_cancelado_sem_pagamento_reabre_mensalidade.test.js).

-- ---------------------------------------------------------------------------
-- 1) titulo_reavaliar: o guarda de 22/09 so segura NEGOCIADO quando a cadeia
--    da mensalidade recebeu pagamento.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.titulo_reavaliar(p_titulo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_situacao text; v_status text; v_acordo_atual uuid;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
  v_acordo_bloqueio uuid; v_status_bloqueio text;
begin
  select situacao, status, acordo_id into v_situacao, v_status, v_acordo_atual
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

  -- Mensalidade NEGOCIADA cujo acordo caiu (CANCELADO/QUEBRADO/INATIVO) SO
  -- continua NEGOCIADA quando algum acordo da cadeia dela chegou a receber
  -- dinheiro (parcela PAGO ou baixa viva): ai a divida passou a ser o saldo
  -- residual DO ACORDO (re-acordo, 22/09/2026), e reabrir a mensalidade pelo
  -- valor cheio cobraria de novo o que ja entrou.
  --
  -- Acordo que caiu SEM NENHUM pagamento na cadeia -- cancelado por falta de
  -- pagamento, o unico que o botao "Cancelar acordo" da ficha aceita -- nao
  -- negociou nada de fato: a mensalidade desce para o caminho de baixo, volta
  -- para ABERTO e fica livre para um acordo novo (Amanda, 25/09/2026). O
  -- vinculo inativo continua na tabela: a composicao do acordo cancelado nao
  -- se perde.
  --
  -- A cadeia e todo acordo pelo qual a mensalidade passou (vinculos ativos ou
  -- nao, mais o acordo_id que o titulo guarda), nao so o ultimo: no re-acordo
  -- A (pago em parte) -> B (cancelado sem pagar), o dinheiro entrou em A.
  --
  -- So entra aqui quando a situacao ATUAL do titulo ja e NEGOCIADO: se nunca
  -- foi negociado, ou se o motivo de nao achar vinculo vivo e outro, o caminho
  -- de baixo decide, como sempre decidiu.
  if v_acordo is null and upper(coalesce(v_situacao,'')) = 'NEGOCIADO' then
    select coalesce(
        (select v.acordo_id from public.acordo_titulo_vinculo v
          where v.titulo_id = p_titulo
          order by v.criado_em desc nulls last limit 1),
        v_acordo_atual)
      into v_acordo_bloqueio;

    if v_acordo_bloqueio is not null then
      select upper(coalesce(status,'')) into v_status_bloqueio
        from public.acordos where id = v_acordo_bloqueio;
    end if;

    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO')
       and exists (
         select 1
           from (select v.acordo_id from public.acordo_titulo_vinculo v
                  where v.titulo_id = p_titulo
                 union
                 select v_acordo_atual) c
          where c.acordo_id is not null
            and (exists (select 1 from public.parcelas p
                          where p.acordo_id = c.acordo_id
                            and upper(coalesce(p.status,'')) = 'PAGO')
                 or exists (select 1 from public.baixas_pagamento b
                             where b.acordo_id = c.acordo_id
                               and b.devolvido_em is null))) then
      return;
    end if;
  end if;

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

comment on function public.titulo_reavaliar(uuid) is
  'Reavalia um titulo contra o acordo vivo dele. PAGO/quitada e CANCELADA/cancelada sao estados terminais. Mensalidade NEGOCIADA cujo acordo caiu (CANCELADO/CANCELADA/QUEBRADO/INATIVO) so continua NEGOCIADA quando algum acordo da cadeia dela recebeu pagamento (re-acordo pelo saldo residual, 22/09/2026); sem nenhum pagamento na cadeia volta para ABERTO (25/09/2026).';

-- ---------------------------------------------------------------------------
-- 2) cancelar_acordo_ficha: SO o comentario interno muda -- o de 22/09 dizia
--    que a mensalidade nunca volta para ABERTO, o que deixa de ser verdade.
--    Ordem (status do acordo antes do vinculo), travas e retorno: intactos.
-- ---------------------------------------------------------------------------
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

  -- Quem decide o destino de cada mensalidade e titulo_reavaliar, disparado
  -- pelo gatilho do UPDATE de status abaixo (trg_acordo_status_reavalia_titulos).
  -- Como as travas acima garantem que este acordo nunca recebeu pagamento, a
  -- mensalidade volta para ABERTO e fica livre para um acordo novo -- a menos
  -- que outro acordo da cadeia dela tenha recebido dinheiro (re-acordo), caso
  -- em que continua NEGOCIADA e a divida e o saldo residual (25/09/2026). Por
  -- isso o status do acordo muda PRIMEIRO: titulo_reavaliar precisa ver o
  -- acordo ja CANCELADO. So depois o vinculo e' desativado -- nunca apagado --
  -- para a cadeia mensalidade->negociacao->acordo continuar inteira na tela e
  -- na auditoria.
  update public.acordos
     set status = 'CANCELADO', saldo = 0, atualizado_em = v_agora
   where id = p_acordo_id;

  update public.acordo_titulo_vinculo
     set ativo = false
   where acordo_id = p_acordo_id and coalesce(ativo, true);
  get diagnostics v_vinculos = row_count;

  update public.parcelas
     set status = 'CANCELADA', atualizado_em = v_agora
   where acordo_id = p_acordo_id
     and upper(coalesce(status, '')) <> 'PAGO';
  get diagnostics v_parcelas = row_count;

  if v_acordo.aluno_id is not null then
    perform public.liberar_caso_por_evento(v_acordo.aluno_id, 'CANCELADO');
  end if;

  return jsonb_build_object(
    'ok', true,
    'acordo_id', p_acordo_id,
    'vinculos_desativados', v_vinculos,
    'parcelas_canceladas', v_parcelas
  );
end;
$function$;
