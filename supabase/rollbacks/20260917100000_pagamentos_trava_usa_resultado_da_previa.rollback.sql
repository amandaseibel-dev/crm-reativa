-- ROLLBACK de 20260917100000_pagamentos_trava_usa_resultado_da_previa.sql
--
-- EXECUTAVEL DE PONTA A PONTA. Recria `pagamentos_trava` exatamente como a
-- migration 20260916230000 a deixou: sem ler `aprovado` e `bloqueios` da previa.
-- Mesma assinatura e mesmo retorno; create or replace preserva as permissoes.
--
-- Efeito de desfazer: a fila volta a oferecer "Registrar acordo a vista" a toda
-- linha ACORDO_AVISTA_AUSENTE, inclusive as que a previa recusa. Nada grava:
-- o registro continua refazendo a previa antes de escrever.
--
-- Nao ha dado a desfazer: a migration so trocou o corpo da funcao.

create or replace function public.pagamentos_trava(p_pagamento_ids uuid[])
 returns table(pagamento_id uuid, trava text, aluno_id uuid, aluno_nome text, numero_ulbra text)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_id uuid;
  v_p jsonb;
  v_ident jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  for v_id in
    select distinct x from unnest(coalesce(p_pagamento_ids, '{}'::uuid[])) x where x is not null limit 500
  loop
    v_p := public.acordo_avista_previa(v_id, null);
    v_ident := v_p -> 'identificacao';
    pagamento_id := v_id;
    aluno_id := (v_ident ->> 'aluno_id')::uuid;
    aluno_nome := v_p -> 'aluno' ->> 'nome';
    numero_ulbra := v_p -> 'boleto' ->> 'numero_ulbra';

    trava := case
      when v_p -> 'pagamento' is null or v_p -> 'pagamento' = 'null'::jsonb then 'NAO_ENCONTRADO'
      when coalesce(v_p -> 'pagamento' ->> 'status_conciliacao', '') <> 'AGUARDANDO_ACORDO' then 'FORA_DO_ESCOPO'
      when coalesce((v_p -> 'boleto' ->> 'acordo_ja_existe')::boolean, false) then 'ACORDO_CHEGOU_AGUARDANDO_RODADA'
      when v_ident ->> 'aluno_id' is not null then
        case when coalesce((v_p -> 'boleto' ->> 'no_padrao')::boolean, false)
                  and v_p -> 'boleto' ->> 'parcela' = '0001'
                  and coalesce((v_p -> 'boleto' ->> 'unico_do_acordo')::boolean, false)
             then case when v_p -> 'boleto' -> 'evidencia_existia_antes' is not null
                            and v_p -> 'boleto' -> 'evidencia_existia_antes' <> 'null'::jsonb
                       then 'ACORDO_AVISTA_AUSENCIA_NAO_EXPLICADA'
                       else 'ACORDO_AVISTA_AUSENTE' end
             else 'ACORDO_PARCELADO_AUSENTE' end
      when v_ident ->> 'aluno_no_pagamento' is not null then 'ALUNO_VINCULADO_SEM_PROVA_DUPLA'
      when (v_ident ->> 'alunos_por_matricula')::int = 1 and (v_ident ->> 'alunos_por_nome')::int = 1
        then 'IDENTIDADE_DIVERGENTE'
      else 'ALUNO_NAO_IDENTIFICADO'
    end;
    return next;
  end loop;
end;
$fn$;

comment on function public.pagamentos_trava(uuid[]) is
  'Diz, para cada pagamento, o ponto exato em que a conciliacao travou (identidade, estrutura do acordo, rodada). A tela so oferece a acao que corresponde a esse ponto. Gestao apenas; sem DML.';