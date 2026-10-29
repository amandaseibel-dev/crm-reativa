-- Acionamento nao volta para nulo. Nunca.
--
-- Amanda, 27/08/2026: "veja todos os casos enviamos acao se foram registrados"
-- -- e, no dia seguinte: "hoje pode comecar a fazer".
--
-- O QUE ACHEI. 8.688 alunos receberam acao massiva desde 15/07. 1.619 estavam
-- com `data_ultimo_acionamento` VAZIO -- e 1.619 de 1.619 tiveram
-- TROCA_RESPONSAVEL depois da acao. Cem por cento: nao e amostra, e causa.
--
-- (Na primeira tentativa procurei em `historico_operadores_alunos` e deu zero;
-- conclui cedo demais que nao era troca de responsavel. O registro estava no
-- `audit_log`, tabela `alunos.responsavel`. Procurar o EVENTO, nao a tabela.)
--
-- A ORIGEM esta em internal.set_resp_aluno:
--     data_ultimo_acionamento = case when trocou_de_dono then null else ... end
--     status_acionamento      = case when trocou_de_dono then null else ... end
--
-- Trocar de dono zerava o historico de contato. Mas ACIONAMENTO E FATO: a
-- ligacao aconteceu, a mensagem foi enviada. Mudar quem cuida do caso nao
-- desfaz o passado -- o que troca de dono e a responsabilidade.
--
-- POR QUE UMA TRAVA E NAO O CONSERTO NA FONTE: a funcao esta no schema
-- `internal` e pertence a outro dono; nao tenho permissao para reescreve-la
-- ("must be owner of function set_resp_aluno"). A trava resolve o mesmo
-- problema e cobre MAIS: qualquer caminho que tente apagar o acionamento,
-- hoje ou amanha, esbarra nela.
--
-- O ESTRAGO que isso para: atinge QUALQUER acionamento, nao so acao massiva.
-- A cada rodada do nivelamento (897 dos 1.619 vieram dele), o contato de quem
-- foi redistribuido some. O aluno reaparece como "nunca acionado" na carteira e
-- no "risco de perder", o trabalho feito e subestimado, e ele volta a entrar em
-- acao massiva -- podendo receber a mesma mensagem duas vezes.
--
-- O QUE A TRAVA PROTEGE: data_ultimo_acionamento e status_acionamento. Fato.
--
-- O QUE ELA NAO PROTEGE, de proposito: proxima_acao, data_retorno e
-- hora_retorno continuam sendo zerados na troca. Sao o PLANO do operador
-- anterior; compromisso de retorno pertence a quem prometeu.
--
-- COMO SE CORRIGE um acionamento errado: a trava so barra a volta para NULO.
-- Escrever uma data nova continua livre.

create or replace function public._acionamento_nao_volta_para_nulo()
returns trigger
language plpgsql
as $function$
begin
  -- Acionamento e fato consumado: uma vez registrado, nao se apaga.
  if old.data_ultimo_acionamento is not null and new.data_ultimo_acionamento is null then
    new.data_ultimo_acionamento := old.data_ultimo_acionamento;
  end if;

  -- A tabulacao do contato acompanha o acionamento.
  if old.status_acionamento is not null
     and nullif(btrim(old.status_acionamento),'') is not null
     and new.status_acionamento is null then
    new.status_acionamento := old.status_acionamento;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_acionamento_nao_volta_para_nulo on public.alunos;
create trigger trg_acionamento_nao_volta_para_nulo
before update of data_ultimo_acionamento, status_acionamento
on public.alunos
for each row execute function public._acionamento_nao_volta_para_nulo();

comment on function public._acionamento_nao_volta_para_nulo() is
  'Impede que data_ultimo_acionamento e status_acionamento voltem a NULO. A troca de responsavel (internal.set_resp_aluno) zerava os dois, apagando 1.619 acionamentos de acao massiva desde 15/07/2026. Acionamento e fato: trocar de dono nao desfaz a ligacao. Escrever valor NOVO continua livre.';
