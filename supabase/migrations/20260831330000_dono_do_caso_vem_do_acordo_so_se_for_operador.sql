-- O aluno sem mensalidade em aberto herda o dono do acordo -- mas so quando esse
-- dono e um OPERADOR de verdade.
--
-- Amanda, 31/08: "quando so tiver um acordo vinculado ao operador e nao tiver
-- mensalidade o responsavel pelo aluno vira apenas o do acordo".
--
-- POR QUE A TRAVA. O gatilho `atribuir_responsavel_por_acordo` ja fazia isso,
-- mas sem olhar QUEM e o responsavel do acordo. E o responsavel do acordo quase
-- nunca e operador: dos acordos ATIVOS, 1.391 estao em `importacao@sistema`
-- (o robo da importacao) e 241 na gerencia. Aplicar a regra ao pe da letra
-- entregaria caso de operador para um robo -- foi exatamente o que aconteceu em
-- 28/08, quando 113 casos foram parar na bancada e tiveram de ser revertidos.
--
-- Medido em 31/08 entre alunos com caso aberto, UM acordo ativo e NENHUMA
-- mensalidade em aberto (1.076 alunos):
--   552  responsavel do acordo e importacao, gerencia ou ADM  -> nao mexer
--    25  aluno sem dono e o acordo tem operador               -> corrigir
--     3  divergem e o do acordo e operador                    -> corrigir
--   496  ja batiam
--
-- Os 28 foram corrigidos na mao no mesmo dia, via internal.set_resp_aluno, com
-- movimentacao ATRIBUICAO_ACORDO registrada. Todos foram para operador; nenhum
-- para gestao ou robo.
--
-- `public.operadores` esta VAZIA -- a fonte de quem e operador e
-- `public.usuarios` com perfil = 'operador' e ativo.

create or replace function public.atribuir_responsavel_por_acordo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_aid uuid;
  v_atual text;
  v_nome text;
  v_aluno_nome text;
  v_valor_br text;
  v_mudou boolean;
  v_aluno_id text;
  v_e_operador boolean;
begin
  if coalesce(new.operador_responsavel_email,'') = '' then
    return new;
  end if;

  v_aluno_id := nullif(btrim(coalesce(new.aluno_id::text, '')), '');
  begin v_aid := v_aluno_id::uuid; exception when others then v_aid := null; end;

  select coalesce(nome, new.operador_responsavel_email),
         (ativo and perfil = 'operador')
    into v_nome, v_e_operador
    from public.usuarios
   where lower(email) = lower(new.operador_responsavel_email)
   limit 1;

  v_mudou := (TG_OP = 'INSERT')
             or (TG_OP = 'UPDATE'
                 and coalesce(old.operador_responsavel_email,'') is distinct from coalesce(new.operador_responsavel_email,''));

  if v_mudou then
    if v_aid is not null then
      select nome into v_aluno_nome from public.alunos where id = v_aid;
    end if;
    v_valor_br := replace(to_char(coalesce(new.valor_total,0), 'FM999999990.00'), '.', ',');

    insert into public.notificacoes
      (usuario_destino_nome, usuario_destino_email, tipo, titulo, mensagem, aluno_id, url_destino, lida)
    values (
      coalesce(v_nome, new.operador_responsavel_email),
      new.operador_responsavel_email,
      'RESPONSAVEL_ACORDO',
      '🤝 Novo acordo sob sua responsabilidade',
      'Você é o responsável por um acordo de R$ ' || v_valor_br
        || ' do aluno ' || coalesce(v_aluno_nome, new.cpf, 'aluno')
        || '. Clique em Abrir para tratar o caso.',
      v_aid,
      case when v_aluno_id is not null then '/aluno?alunoId=' || v_aluno_id else '/painel-carteira' end,
      false
    );
  end if;

  -- o aluno so passa a ser do dono do acordo se esse dono for OPERADOR ativo.
  -- gerencia, supervisao, administrativo e importacao@sistema nunca viram donos
  -- de caso -- ver docs/PREMISSAS.md e a reversao de 28/08.
  if v_aid is not null and coalesce(v_e_operador, false) then
    select responsavel_atual_email into v_atual from public.alunos where id = v_aid;
    if coalesce(trim(v_atual),'') = '' then
      perform internal.set_resp_aluno(
        v_aid, new.operador_responsavel_email, coalesce(v_nome, new.operador_responsavel_email),
        'ATRIBUICAO_ACORDO', 'Responsavel definido pelo acordo',
        new.operador_responsavel_email, coalesce(v_nome, new.operador_responsavel_email));
    end if;
  end if;

  return new;
end;
$function$;
