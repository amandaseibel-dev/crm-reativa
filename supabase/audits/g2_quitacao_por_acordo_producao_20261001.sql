-- CORPOS DE PRODUCAO, lidos de ahattpqrjmhkzsmnbdzs em 01/10/2026.
-- Copia literal de pg_get_functiondef. NAO EDITAR A MAO: este arquivo e a
-- bancada dos testes do G2 -- ele existe para que o teste rode o motor REAL e a
-- CAUSA REAL, nao uma reescrita conveniente. O primeiro teste do arquivo
-- g2_quitacao_por_acordo_comportamento.test.js confere o md5 de cada corpo
-- contra o md5 de producao: se alguem editar isto a mao, o teste cai.
--
-- md5(prosrc) / bytes em 01/10/2026:
--   titulo_reavaliar                     efdf3fd198a56198223ade82e4991d40 / 5625
--   _titulo_situacao_e_status_coerentes   938d1081a89106b4a37b116321d9d819 /  791
--   titulo_situacao_por_vinculo           597e619bd709b70de3772d86f19cf8c8 /  258
--   _acordo_status_reavalia_titulos       da92e1a790d17f41e4e28e96e8a86fe0 /  331
--   titulos_por_status_acordo             67e21573381adb98f82fd9c8ff969bfc / 1538  <-- COM O DEFEITO
--   _titulo_quita_com_o_acordo            bde4388c3a26ea98f66e5163eef9bd51 /  994
--   _acordo_fecha_com_a_ultima_parcela    9a2301342f99c312e7bfa971ac621a1e /  763
--   _trg_auto_quitar_titulo               8aa914112e90dd8bf960335f1bd8b213 /  644

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

CREATE OR REPLACE FUNCTION public._titulo_situacao_e_status_coerentes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.titulo_situacao_por_vinculo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_titulo uuid;
begin
  foreach v_titulo in array
    array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null)
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION public._acordo_status_reavalia_titulos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_titulo uuid;
begin
  for v_titulo in
    select distinct t.id from public.acordos_titulos t
     where t.acordo_id = new.id
    union
    select distinct v.titulo_id from public.acordo_titulo_vinculo v
     where v.acordo_id = new.id
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return null;
end;
$function$;

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
    -- A MENSALIDADE NEGOCIADA NAO VOLTA A SER ABERTA AQUI (branch removida em
    -- 22/09/2026): cancelar o acordo muda o estado do ACORDO, nao desfaz
    -- retroativamente a negociacao das mensalidades originais. Quem decide o
    -- destino do titulo e titulo_reavaliar, chamado pelo outro gatilho desta
    -- mesma tabela (trg_acordo_status_reavalia_titulos) -- ele preserva
    -- NEGOCIADO quando o motivo e so o acordo ter caido.

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

CREATE OR REPLACE FUNCTION public._titulo_quita_com_o_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if upper(coalesce(new.status,'')) <> 'QUITADO'
     or upper(coalesce(old.status,'')) = 'QUITADO' then
    return new;
  end if;

  -- acordo marcado quitado mas com parcela viva nao quita mensalidade nenhuma
  if exists (select 1 from public.parcelas p
              where p.acordo_id = new.id
                and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA')) then
    return new;
  end if;

  update public.acordos_titulos t
     set situacao = 'PAGO', status = 'quitada',
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'')='' then '' else ' | ' end
           || 'quitada junto com o acordo ' || coalesce(new.numero_acordo::text,'')
           || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
         atualizado_em = now()
   where t.acordo_id = new.id
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO');

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public._acordo_fecha_com_a_ultima_parcela()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_acordo uuid;
begin
  v_acordo := coalesce(new.acordo_id, old.acordo_id);
  if v_acordo is null then return null; end if;

  update public.acordos a
     set status = 'QUITADO', saldo = 0,
         motivo_ajuste = coalesce(a.motivo_ajuste,'')
           || case when coalesce(a.motivo_ajuste,'')='' then '' else ' | ' end
           || 'quitado automaticamente: a ultima parcela foi paga',
         atualizado_em = now()
   where a.id = v_acordo
     and upper(coalesce(a.status,'')) = 'ATIVO'
     and exists (select 1 from public.parcelas p where p.acordo_id = a.id)
     and not exists (select 1 from public.parcelas p where p.acordo_id = a.id
                      and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public._trg_auto_quitar_titulo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- EM_CONFIRMACAO conta como divida ainda nao resolvida: entrar nele nao
  -- quita ninguem; sair dele para PAGO (baixa confirmada) segue quitando.
  -- CANCELADA e saida ADMINISTRATIVA (saiu da base / encerramento pela
  -- Conferencia Prime): nao e quitacao, nao chama _talvez_quitar_aluno.
  if upper(coalesce(new.situacao,'')) = 'CANCELADA' then
    return new;
  end if;
  if upper(coalesce(old.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO') then
    perform public._talvez_quitar_aluno(new.aluno_id);
  end if;
  return new;
end;
$function$;
