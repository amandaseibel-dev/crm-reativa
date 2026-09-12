create or replace function public.casos_reabrir_com_divida(p_limite integer default null::integer)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '180s'
as $function$
declare
  v_bloq text[] := array['JURIDICO','CANCELAMENTO COBRANCA','SUSPENSAO COBRANCA',
                         'SUSPENSAO DE COBRANCA','CANCELADO'];
  v_n integer := 0;
  v_pulados integer := 0;
  v_falhas integer := 0;
  v_criados integer := 0;
  v_criar_falhas integer := 0;
  v_codigo integer;
  r record;
  r2 record;
begin
  for r in
    select c.id, c.aluno_id, c.status_atual as st_ant
      from public.casos c
     where c.aluno_id is not null
       and (coalesce(c.encerrado_operacional, false)
            or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                                 c.status_financeiro, c.status_jornada))
       -- SO reabre quem nao tem NENHUM caso aberto. Sem isto o reabridor
       -- ressuscita a copia duplicada que a fusao acabou de aposentar.
       -- (Continua aqui porque poda a lista cedo; a decisao final e no laco.)
       and not exists (
         select 1 from public.casos c2
          where c2.aluno_id = c.aluno_id and c2.id <> c.id
            and not coalesce(c2.encerrado_operacional, false))
       and public.normalizar_status_acionamento(coalesce(c.status_atual,''))       <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_acionamento,'')) <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_financeiro,''))  <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_jornada,''))     <> all(v_bloq)
       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'
       and not exists (select 1 from public.alunos al
                        where al.id = c.aluno_id
                          and upper(coalesce(al.status_atual,'')) ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO')
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric > 0.005
     limit coalesce(p_limite, 100000)
  loop
    -- CONSERTO 1. A lista acima e uma fotografia. Se o proprio laco ja devolveu
    -- OUTRO caso deste aluno para a fila, este aqui nao entra: a ficha do aluno
    -- e unica. Mesmo criterio do gatilho _caso_nao_duplica_aluno(), para a
    -- decisao aqui e a trava la nunca discordarem.
    if exists (
      select 1 from public.casos c2
       where c2.aluno_id = r.aluno_id
         and c2.id <> r.id
         and not coalesce(c2.encerrado_operacional, false)
         and public.caso_encerrado_operacional(c2.cpf, c2.status_atual, c2.status_acionamento,
                                               c2.status_financeiro, c2.status_jornada) = false
    ) then
      v_pulados := v_pulados + 1;
      continue;
    end if;

    -- CONSERTO 2. Uma ficha ruim nunca mais leva junto as outras.
    begin
      update public.casos
         set status_atual = 'Em cobrança',
             status_acionamento = null,
             status_jornada = 'Em cobrança',
             status_financeiro = case
               when public.normalizar_status_acionamento(coalesce(status_financeiro,''))
                    in ('QUITADO','PAGO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                        'SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO')
                 then null
               else status_financeiro end,
             -- A LINHA QUE FALTAVA. Sem ela o caso mudava de status mas seguia
             -- fora da fila, e o cron o repescava toda hora, gravando outra
             -- movimentacao de reabertura que nao reabria nada.
             encerrado_operacional = false,
             caso_atualizado_por = 'sistema_reabrir_com_divida',
             caso_atualizado_em = now()
       where id = r.id;

      update public.alunos
         set status_atual = 'Em cobrança',
             status_jornada = 'Em cobrança',
             status_acionamento = null
       where id = r.aluno_id
         and upper(coalesce(status_atual,'')) !~ 'JURIDICO|CANCELAMENTO|SUSPENSAO';

      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em)
      values (r.aluno_id::text, 'REABERTURA_DIVIDA_NOVA',
              'Caso estava fora da base como "' || coalesce(r.st_ant,'(sem status)')
              || '" mas voltou a ter saldo em aberto. Devolvido para a fila.',
              coalesce(r.st_ant,'(sem)'), 'Em cobrança',
              'Sistema', 'sistema_reabrir_com_divida', now());

      perform public.recalcular_situacao_aluno(r.aluno_id, 'reabrir_com_divida');
      v_n := v_n + 1;
    exception when others then
      v_falhas := v_falhas + 1;
      raise warning 'casos_reabrir_com_divida: caso % do aluno % nao foi reaberto e foi pulado: %',
        r.id, r.aluno_id, sqlerrm;
    end;
  end loop;

  -- ---------------------------------------------------------------------------
  -- CONSERTO 3 (11/09/2026). O PONTO CEGO: aluno com divida e sem caso NENHUM.
  -- O laco de cima varre `casos`; quem nao tem caso nunca e visto. A importacao
  -- de bordero cria aluno e titulo sem criar caso, e nenhum gatilho supre isso.
  -- Mesmo porteiro de divida e mesma lista de bloqueio do laco de cima.
  -- ---------------------------------------------------------------------------
  select coalesce(max(caso_codigo), 0) into v_codigo from public.casos;

  for r2 in
    select al.id as aluno_id, al.nome, al.cpf, al.cpf_corrigido, al.matricula,
           al.unidade, al.curso, al.email, al.telefone, al.status_atual as st_ant,
           (public.aluno_saldo_pendente_detalhe(al.id)->>'total')::numeric as total
      from public.alunos al
     where not exists (select 1 from public.casos c where c.aluno_id = al.id)
       and public.normalizar_status_acionamento(coalesce(al.status_atual,''))       <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(al.status_jornada,''))     <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(al.status_acionamento,'')) <> all(v_bloq)
       and upper(coalesce(al.status_atual,'')) !~ 'JURIDICO|CANCELAMENTO|SUSPENSAO|CANCEL'
       -- A trava _caso_nao_duplica_aluno() protege por aluno_id e NAO ve CPF.
       -- CPF com duas fichas de aluno, uma delas ja com caso, viraria duas
       -- fichas na fila. Fica de fora e vai para conferencia manual.
       and not exists (
         select 1 from public.alunos a2
           join public.casos c2 on c2.aluno_id = a2.id
          where a2.id <> al.id
            and nullif(regexp_replace(coalesce(a2.cpf_corrigido, a2.cpf, ''), '\D', '', 'g'), '') is not null
            and lpad(regexp_replace(coalesce(a2.cpf_corrigido, a2.cpf, ''), '\D', '', 'g'), 11, '0')
              = lpad(regexp_replace(coalesce(al.cpf_corrigido, al.cpf, ''), '\D', '', 'g'), 11, '0'))
       and (public.aluno_saldo_pendente_detalhe(al.id)->>'total')::numeric > 0.005
     order by al.created_at
     limit coalesce(p_limite, 100000)
  loop
    begin
      v_codigo := v_codigo + 1;

      insert into public.casos
        (aluno_id, caso_codigo, nome_aluno, nome, nome_completo,
         cpf, cpf_limpo, matricula, unidade, curso, email, telefone,
         total_em_aberto, status_atual, status_jornada, encerrado_operacional,
         origem, caso_atualizado_por, caso_atualizado_em, created_at)
      values (r2.aluno_id, v_codigo, r2.nome, r2.nome, r2.nome,
              r2.cpf,
              nullif(regexp_replace(coalesce(r2.cpf_corrigido, r2.cpf, ''), '\D', '', 'g'), ''),
              r2.matricula, r2.unidade, r2.curso, r2.email, r2.telefone,
              round(r2.total, 2), 'Em cobrança', 'Em cobrança', false,
              'SISTEMA_CASO_FALTANDO', 'sistema_caso_faltando', now(), now());

      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
      values (r2.aluno_id::text, 'CASO_CRIADO_DIVIDA',
              'Aluno tinha saldo em aberto e nenhuma ficha operacional -- estava fora de'
              || ' todas as filas. Ficha criada pelo sistema e colocada em cobrança.',
              coalesce(r2.st_ant, '(sem ficha)'), 'Em cobrança',
              'Sistema', 'sistema_caso_faltando', now(), round(r2.total, 2));

      perform public.recalcular_situacao_aluno(r2.aluno_id, 'caso_faltando');
      v_criados := v_criados + 1;
    exception when others then
      v_criar_falhas := v_criar_falhas + 1;
      raise warning 'casos_reabrir_com_divida: aluno % sem caso nao foi criado e foi pulado: %',
        r2.aluno_id, sqlerrm;
    end;
  end loop;

  if v_pulados > 0 or v_falhas > 0 or v_criados > 0 or v_criar_falhas > 0 then
    raise warning 'casos_reabrir_com_divida: % reaberto(s), % pulado(s) por ja terem caso aberto, % com erro; % ficha(s) criada(s) para aluno com divida e sem caso, % com erro',
      v_n, v_pulados, v_falhas, v_criados, v_criar_falhas;
  end if;

  return v_n + v_criados;
end;
$function$;
