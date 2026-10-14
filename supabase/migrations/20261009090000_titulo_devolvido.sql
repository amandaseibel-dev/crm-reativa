-- TITULO DEVOLVIDO: encerramento SEM recuperacao da ReATIVA.
--
-- O PROBLEMA. Cancelamento de cobranca, suspensao, FIES/bolsa e equivalentes
-- encerram a cobranca sem que um centavo tenha entrado por nosso trabalho. Ate
-- aqui o titulo ia para CANCELADA -- a mesma palavra usada quando a divida
-- deixa de existir por erro de base. Sao coisas diferentes: aqui a divida foi
-- DEVOLVIDA ao cliente, e chamar isso de cancelamento apaga a diferenca entre
-- "nao existia" e "existia e saiu da nossa mao sem recuperacao".
--
-- A REGRA. O titulo fica situacao='DEVOLVIDO' / status='devolvido', com o saldo
-- cobravel zerado, o motivo, o usuario, a data e a auditoria preservados --
-- e NUNCA vira pagamento: `origem_liquidacao` segue nulo e nenhum pagamento,
-- acordo, parcela ou vinculo e criado.
--
-- POR QUE O SALDO ZERA SOZINHO. `saldo_cobravel_aluno` soma apenas titulos com
-- `situacao IN ('ABERTO','NEGOCIADO')`. DEVOLVIDO nao esta la, entao sai da
-- conta pela porta que ja existe -- nao por mais uma lista de excecao espalhada
-- pelos leitores. Foi por isso que este desenho mexe em 8 objetos e nao nos 137
-- que tocam a tabela: medi antes de escrever, e so 1 funcao filtrava o status
-- do titulo por EXCLUSAO (`invariantes_rodar`, que compara com 'em_aberto' e
-- portanto nao se engana com um valor novo).
--
-- A DIVIDA CONTINUA REGISTRADA. `valor_original`, `saldo_corrigido` e o
-- historico ficam no lugar. O que sai e a COBRABILIDADE, nao o fato.

-- -----------------------------------------------------------------------------
-- 1. O GATILHO DE COERENCIA aprende o par DEVOLVIDO <-> devolvido
-- -----------------------------------------------------------------------------
-- Sem isto, gravar situacao='DEVOLVIDO' deixaria o status antigo para tras e a
-- tabela passaria a mentir sobre si mesma em duas colunas.
create or replace function public._titulo_situacao_e_status_coerentes()
returns trigger
language plpgsql
set search_path to 'public'
as $$
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
  elsif v_sit = 'DEVOLVIDO' and v_st <> 'devolvido' then
    -- encerrado SEM recuperacao da ReATIVA: a divida volta ao cliente
    new.status := 'devolvido';
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. A TRAVA DE REABERTURA aceita DEVOLVIDO como desfecho legitimo
-- -----------------------------------------------------------------------------
-- Ela existe para impedir que um titulo encerrado administrativamente volte a
-- ser cobrado por um UPDATE qualquer. Como estava, ela conhecia UM desfecho
-- (CANCELADA) e reescrevia qualquer outro -- inclusive DEVOLVIDO, que e
-- justamente o certo. Agora os dois sao aceitos, e qualquer tentativa de sair
-- deles continua recusada e auditada.
create or replace function public._titulo_encerrado_administrativo_protegido()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_oficial boolean := coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on';
  v_sit text := upper(coalesce(new.situacao,''));
  v_st  text := lower(coalesce(new.status,''));
  v_terminal boolean;
begin
  if v_oficial or old.origem_encerramento is null then
    return new;
  end if;

  -- par coerente e terminal: CANCELADA/cancelada ou DEVOLVIDO/devolvido
  v_terminal := (v_sit = 'CANCELADA' and v_st = 'cancelada')
             or (v_sit = 'DEVOLVIDO' and v_st = 'devolvido');

  if not v_terminal
     or new.origem_encerramento is distinct from old.origem_encerramento
     or new.origem_encerramento_ref is distinct from old.origem_encerramento_ref
     or new.origem_encerramento_em is distinct from old.origem_encerramento_em then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('sistema', 'TITULO_ENCERRADO_ADMINISTRATIVO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,
            jsonb_build_object('documento', old.documento, 'tentou_situacao', new.situacao, 'tentou_status', new.status));
    -- devolve ao desfecho que o titulo JA TINHA -- nao a um fixo, senao um
    -- titulo devolvido viraria cancelado ao ser tocado por qualquer rotina.
    new.situacao := old.situacao;
    new.status := old.status;
    new.origem_encerramento := old.origem_encerramento;
    new.origem_encerramento_ref := old.origem_encerramento_ref;
    new.origem_encerramento_em := old.origem_encerramento_em;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. OS DOIS ESCRITORES passam a gravar DEVOLVIDO
-- -----------------------------------------------------------------------------
-- Patch ancorado, nao reescrita: as duas funcoes sao grandes e so precisam
-- trocar o desfecho. Cada bloco aborta se a ancora faltar ou repetir, e e
-- idempotente pelo texto NOVO.

-- 3a. A Conferencia Prime.
do $$
declare
  v_def text := pg_get_functiondef('public.prime_conferencia_encerrar_administrativo(uuid,text)'::regprocedure);
  v_novo text; a text[]; n int;
  pares text[][] := array[
    array[$a$set situacao = 'CANCELADA', status = 'cancelada',$a$,
          $b$set situacao = 'DEVOLVIDO', status = 'devolvido', valor_em_aberto = 0,$b$],
    array[$a$<> 'CANCELADA/cancelada' then
    raise exception 'TRAVA: titulo nao ficou CANCELADA/cancelada';$a$,
          $b$<> 'DEVOLVIDO/devolvido' then
    raise exception 'TRAVA: titulo nao ficou DEVOLVIDO/devolvido';$b$],
    array[$a$'EM_CONFIRMACAO', 'CANCELADA', v_email, v_email, now(), v_valor);$a$,
          $b$'EM_CONFIRMACAO', 'DEVOLVIDO', v_email, v_email, now(), v_valor);$b$],
    array[$a$'GESTAO', coalesce(nullif(v_email,''),'gestao'), 'CANCELADA')$a$,
          $b$'GESTAO', coalesce(nullif(v_email,''),'gestao'), 'DEVOLVIDO')$b$],
    array[$a$'situacao_titulo', 'CANCELADA'$a$, $b$'situacao_titulo', 'DEVOLVIDO'$b$]
  ];
begin
  if position($x$status = 'devolvido'$x$ in v_def) > 0 then return; end if;
  v_novo := v_def;
  foreach a slice 1 in array pares loop
    n := (length(v_novo) - length(replace(v_novo, a[1], ''))) / length(a[1]);
    if n <> 1 then
      raise exception 'encerrar_administrativo: ancora ausente ou repetida (% vezes): %', n, left(a[1], 50);
    end if;
    v_novo := replace(v_novo, a[1], a[2]);
  end loop;
  execute v_novo;
end $$;

-- 3b. O motor generico de efeito sem pagamento (cancelamento, suspensao,
--     FIES/bolsa). Tres mudancas, e so elas:
--
--     (i)   o desfecho passa a ser DEVOLVIDO, com `valor_em_aberto = 0`;
--     (ii)  o alcance passa a incluir EM_CONFIRMACAO -- um titulo que estava
--           parado na Conferencia Prime tambem precisa ser devolvido quando a
--           cobranca e encerrada, e antes ele ficava preso na fila para sempre;
--     (iii) por causa de (ii), o UPDATE roda sob o GUC da Conferencia Prime
--           (`_titulo_em_confirmacao_protegido` so deixa sair por ali) e a
--           decisao pendente e ENCERRADA, para o titulo sumir da fila.
do $$
declare
  v_def text := pg_get_functiondef('public.parcela_efeito_sem_pagamento_aplicar(uuid,text,text,boolean)'::regprocedure);
  v_novo text; a text[]; n int;
  pares text[][] := array[
    -- (i) + (iii): desfecho e GUC
    array[$a$    with e as (
      update public.acordos_titulos t
         set situacao = 'CANCELADA',
             status   = 'cancelada',$a$,
          $b$    perform set_config('conferencia_prime.decisao', 'on', true);
    with e as (
      update public.acordos_titulos t
         set situacao = 'DEVOLVIDO',
             status   = 'devolvido',
             valor_em_aberto = 0,$b$],
    -- (ii) alcance. A ancora aparece DUAS vezes de proposito -- na previa do
    --      dry run e no efeito real -- e as duas sao trocadas pelo mesmo
    --      replace. E o que garante que a previa continue prometendo
    --      exatamente o que o efeito faz.
    array[$a$       where t.aluno_id = p_aluno_id
         and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')$a$,
          $b$       where t.aluno_id = p_aluno_id
         and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')$b$]
  ];
begin
  if position($x$status   = 'devolvido'$x$ in v_def) > 0 then return; end if;
  v_novo := v_def;
  foreach a slice 1 in array pares loop
    n := (length(v_novo) - length(replace(v_novo, a[1], ''))) / length(a[1]);
    if n < 1 then
      raise exception 'efeito_sem_pagamento: ancora ausente: %', left(a[1], 60);
    end if;
    v_novo := replace(v_novo, a[1], a[2]);
  end loop;

  -- (iii) fechar o GUC e encerrar a decisao pendente, logo depois do bloco (b).
  n := (length(v_novo) - length(replace(v_novo,
         $a$    select count(*), coalesce(sum(valor),0) into v_tit_qtd, v_tit_val from e;
  end if;$a$, ''))) / length($a$    select count(*), coalesce(sum(valor),0) into v_tit_qtd, v_tit_val from e;
  end if;$a$);
  if n <> 1 then
    raise exception 'efeito_sem_pagamento: ancora do fechamento ausente ou repetida (%).', n;
  end if;
  v_novo := replace(v_novo,
    $a$    select count(*), coalesce(sum(valor),0) into v_tit_qtd, v_tit_val from e;
  end if;$a$,
    $b$    select count(*), coalesce(sum(valor),0) into v_tit_qtd, v_tit_val from e;

    -- A FILA DA CONFERENCIA PRIME. Um titulo que estava em confirmacao acabou
    -- de ser devolvido: a decisao pendente nao tem mais o que decidir, e sem
    -- encerra-la o titulo ficaria na fila para sempre, oferecendo acoes sobre
    -- algo que ja saiu da cobranca.
    update public.prime_conferencia_decisao d
       set decisao = 'ENCERRADO_ADMINISTRATIVO',
           motivo = 'titulo devolvido por ' || p_origem || ': ' || btrim(p_motivo),
           decidido_por = coalesce(nullif(v_email,''), 'sistema'),
           decidido_em = now()
      from public.acordos_titulos t
     where t.id = d.titulo_id
       and t.aluno_id = p_aluno_id
       and d.decisao = 'PENDENTE'
       and upper(coalesce(t.situacao,'')) = 'DEVOLVIDO'
       and t.origem_encerramento_ref = v_ref;

    perform set_config('conferencia_prime.decisao', 'off', true);
  end if;$b$);
  execute v_novo;
end $$;

-- -----------------------------------------------------------------------------
-- 4. OS LEITORES que listavam os desfechos terminais aprendem o novo
-- -----------------------------------------------------------------------------
-- Estes quatro enumeravam os status em que um titulo NAO esta mais em aberto.
-- Sem 'devolvido' na lista, um titulo devolvido voltaria a ser oferecido para
-- acordo e seria contado como pendencia. Medi um a um: sao os unicos.
do $$
declare
  alvos text[][] := array[
    array['public.quitar_e_encerrar_caso(uuid,numeric,date,boolean)',
          $a$not in ('quitada','cancelada','cancelado')$a$,
          $b$not in ('quitada','cancelada','cancelado','devolvido')$b$],
    array['public.titulos_disponiveis_para_acordo(uuid)',
          $a$('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')$a$,
          $b$('vinculada','quitada','quitado','paga','pago','cancelada','cancelado','devolvido')$b$],
    array['public.vincular_titulos_acordo(uuid[],uuid)',
          $a$('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')$a$,
          $b$('vinculada','quitada','quitado','paga','pago','cancelada','cancelado','devolvido')$b$],
    array['public.titulo_reavaliar(uuid)',
          $a$or lower(coalesce(v_status,'')) = 'cancelada' then$a$,
          $b$or lower(coalesce(v_status,'')) in ('cancelada','devolvido') then$b$]
  ];
  alvo text[]; v_def text; v_novo text; n int; v_oid oid;
begin
  foreach alvo slice 1 in array alvos loop
    -- AUSENTE NAO E ERRO, MAS MUDADO E. Uma fixture reduzida pode nao ter a
    -- funcao; producao tem as quatro (conferi uma a uma). O que nao se tolera e
    -- a funcao existir e a ancora nao casar -- ai o corpo mudou sob os pes
    -- deste patch, e seguir em frente gravaria o estado errado.
    v_oid := to_regprocedure(alvo[1]);
    if v_oid is null then
      continue;
    end if;
    v_def := pg_get_functiondef(v_oid);
    if position(alvo[3] in v_def) > 0 then
      continue;  -- ja aplicado
    end if;
    n := (length(v_def) - length(replace(v_def, alvo[2], ''))) / length(alvo[2]);
    if n < 1 then
      raise exception '%: ancora ausente: %', alvo[1], left(alvo[2], 50);
    end if;
    v_novo := replace(v_def, alvo[2], alvo[3]);
    execute v_novo;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 5. A PROVA DE QUE A CONTA FECHA, dentro da propria migration
-- -----------------------------------------------------------------------------
-- Um titulo DEVOLVIDO tem de sair do saldo cobravel e NAO pode ser contado
-- como pagamento. A checagem roda sobre os dados reais, aborta a migration se
-- falhar, e nao escreve nada.
do $$
declare v_fora int; v_pago int;
begin
  -- nenhum titulo devolvido pode estar em situacao que o saldo soma
  select count(*) into v_fora from public.acordos_titulos
   where lower(coalesce(status,'')) = 'devolvido'
     and upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO');
  if v_fora > 0 then
    raise exception 'DEVOLVIDO em situacao cobravel: % titulos', v_fora;
  end if;

  -- devolver nunca e liquidar
  select count(*) into v_pago from public.acordos_titulos
   where lower(coalesce(status,'')) = 'devolvido' and origem_liquidacao is not null;
  if v_pago > 0 then
    raise exception 'DEVOLVIDO com origem_liquidacao: % titulos', v_pago;
  end if;
end $$;

-- Todo objeto PRESENTE neste ambiente tem de ter aprendido o novo desfecho.
-- E o contrapeso da tolerancia acima: pular o ausente, nunca o desatualizado.
do $$
declare
  obj text; v_oid oid; v_falta text := '';
  objs text[] := array[
    'public.prime_conferencia_encerrar_administrativo(uuid,text)',
    'public.parcela_efeito_sem_pagamento_aplicar(uuid,text,text,boolean)',
    'public.quitar_e_encerrar_caso(uuid,numeric,date,boolean)',
    'public.titulos_disponiveis_para_acordo(uuid)',
    'public.vincular_titulos_acordo(uuid[],uuid)',
    'public.titulo_reavaliar(uuid)'];
begin
  foreach obj in array objs loop
    v_oid := to_regprocedure(obj);
    if v_oid is not null and position('devolvido' in pg_get_functiondef(v_oid)) = 0 then
      v_falta := v_falta || obj || ' ';
    end if;
  end loop;
  if v_falta <> '' then
    raise exception 'objetos presentes que NAO aprenderam DEVOLVIDO: %', v_falta;
  end if;
end $$;

comment on column public.acordos_titulos.status is
  'em_aberto | vinculada | quitada | em_confirmacao | cancelada | devolvido. '
  'DEVOLVIDO = a cobranca foi encerrada SEM recuperacao da ReATIVA (cancelamento, '
  'suspensao, FIES/bolsa e equivalentes): o saldo cobravel zera, a divida segue '
  'registrada, e NAO e pagamento -- origem_liquidacao continua nula. Difere de '
  'CANCELADA, que e a divida que deixou de existir.';
