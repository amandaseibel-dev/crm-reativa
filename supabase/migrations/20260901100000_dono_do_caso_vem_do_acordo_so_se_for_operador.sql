-- Amanda, 31/08: "acordos a vencer estao perdendo o caso para os operadores".
--
-- O gatilho passava o aluno para o dono do acordo sem perguntar QUEM era esse
-- dono. Quando o acordo era lancado pela bancada (perfil bancada/gestao), o
-- aluno saia da carteira do operador e ia para quem so lancou o acordo --
-- 113 casos tiveram de ser revertidos em 28/08.
--
-- Regra: so perfil OPERADOR ativo vira dono do caso. A notificacao continua
-- indo para quem e responsavel pelo acordo, seja qual for o perfil.
-- Ver [[bancada-nao-vira-dona-do-caso]].

create or replace function public.atribuir_responsavel_por_acordo()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_aid uuid; v_atual text; v_nome text; v_aluno_nome text;
  v_valor_br text; v_mudou boolean; v_aluno_id text; v_e_operador boolean;
begin
  if coalesce(new.operador_responsavel_email,'') = '' then return new; end if;

  v_aluno_id := nullif(btrim(coalesce(new.aluno_id::text, '')), '');
  begin v_aid := v_aluno_id::uuid; exception when others then v_aid := null; end;

  select coalesce(nome, new.operador_responsavel_email),
         (ativo and perfil = 'operador')
    into v_nome, v_e_operador
    from public.usuarios where lower(email) = lower(new.operador_responsavel_email) limit 1;

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
      coalesce(v_nome, new.operador_responsavel_email), new.operador_responsavel_email,
      'RESPONSAVEL_ACORDO', '🤝 Novo acordo sob sua responsabilidade',
      'Você é o responsável por um acordo de R$ ' || v_valor_br
        || ' do aluno ' || coalesce(v_aluno_nome, new.cpf, 'aluno')
        || '. Clique em Abrir para tratar o caso.',
      v_aid,
      case when v_aluno_id is not null then '/aluno?alunoId=' || v_aluno_id else '/painel-carteira' end,
      false);
  end if;

  -- o aluno so passa a ser do dono do acordo se esse dono for OPERADOR ativo.
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
