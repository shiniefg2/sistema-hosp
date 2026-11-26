"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// =====================================================
// CONFIGURAÇÃO
// =====================================================

const frontendPath = path.resolve(__dirname, "../frontend");
const SEED_FILE = path.join(__dirname, "db.json");

// Na Vercel o disco do projeto é somente leitura: só /tmp aceita escrita
// (e é temporário). Para dados permanentes use um banco de dados de verdade.
const EM_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = EM_VERCEL ? "/tmp" : __dirname;
const DB_FILE = process.env.BAYMAX_DB_FILE
  ? path.resolve(process.env.BAYMAX_DB_FILE)
  : path.join(DATA_DIR, "db.json");

const defaultDB = {
  medicacoesDisponiveis: [],
  movimentacoes: [],
  usuarios: [],
  pessoas: [],
  agendamentos: [],
  examesCatalogo: [],
  solicitacoesExames: [],
  salasCirurgicas: [],
  procedimentosCirurgicos: [],
  cirurgias: [],
  leitos: [],
  internacoes: [],
  evolucoesEnfermagem: [],
  sinaisVitaisEnfermagem: [],
  balancosHidricos: [],
  procedimentosEnfermagem: [],
  prescricoesInternacao: [],
  administracoesMedicacao: [],
  pacientes: [],
  triagens: [],
  consultas: [],
  medicacoes: [],
  chamadas: [],
  altas: [],
  plantoes: [],
  auditoria: []
};

const TIPOS_PERMITIDOS = [
  "atendimento",
  "triagem",
  "medico",
  "enfermagem",
  "tecnico_enfermagem",
  "laboratorista",
  "medicacao",
  "almoxarifado",
  "centro_cirurgico",
  "gestor",
  "alta",
  "admin"
];

const TIPOS_ALTA = ["Alta Curado", "Alta a Pedido", "Transferencia", "Evasao"];
const RISCOS = ["verde", "amarelo", "vermelho"];
const VALIDADE_TOKEN_MS = 12 * 60 * 60 * 1000;

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

// =====================================================
// UTILITÁRIOS
// =====================================================

const clone = obj => JSON.parse(JSON.stringify(obj));
const agora = () => new Date().toISOString();
const texto = v => (typeof v === "string" ? v.trim() : "");

let ultimoId = 0;
// ID baseado no horário, mas nunca repetido (Date.now() pode colidir)
function novoId() {
  ultimoId = Math.max(Date.now(), ultimoId + 1);
  return ultimoId;
}

// Próximo ID sequencial para listas simples
function proximoId(lista) {
  return lista.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
}

// Converte para inteiro >= 0; retorna null se for inválido
function lerQuantidade(valor) {
  if (typeof valor !== "number" && typeof valor !== "string") return null;
  if (typeof valor === "string" && !valor.trim()) return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function ultimo(lista, condicao) {
  for (let i = lista.length - 1; i >= 0; i--) {
    if (condicao(lista[i])) return lista[i];
  }
  return undefined;
}

const nomeDe = u => texto(u.nome) || u.usuario;
const nomePadraoDe = u => texto(u.nomePadrao) || nomeDe(u);
const mesmoLogin = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const cpfNormalizado = cpf => (typeof cpf === "string" ? cpf.replace(/\D/g, "") : "");
const publico = u => ({ usuario: u.usuario, nome: nomeDe(u), tipo: u.tipo });
function perfilDoUsuario(u) {
  return {
    ...publico(u),
    fotoPerfil: typeof u.fotoPerfil === "string" && u.fotoPerfil ? u.fotoPerfil : null
  };
}

const contarAdmins = db => db.usuarios.filter(u => u.tipo === "admin").length;

function registrarAuditoria(db, usuario, acao, entidade, entidadeId = null) {
  db.auditoria.push({
    id: novoId(),
    usuario,
    acao,
    entidade,
    entidadeId,
    createdAt: agora()
  });

  if (db.auditoria.length > 5000) {
    db.auditoria = db.auditoria.slice(-5000);
  }
}

function listarAlergias(db, paciente) {
  const pessoa = db.pessoas.find(item => Number(item.id) === Number(paciente.pessoaId));
  const registros = db.triagens
    .filter(t => Number(t.pacienteId) === Number(paciente.id))
    .map(t => t.alergia);
  const valores = [
    ...(pessoa && Array.isArray(pessoa.alergias) ? pessoa.alergias : []),
    ...(Array.isArray(paciente.alergias) ? paciente.alergias : []),
    ...registros
  ];
  return [...new Set(valores.flatMap(valor =>
    typeof valor === "string"
      ? valor.split(/[,;]+/).map(item => item.trim()).filter(Boolean)
      : []
  ))];
}

function migrarPessoasLegadas(db) {
  let alterado = false;

  db.pacientes
    .slice()
    .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))
    .forEach(atendimento => {
      const cpf = cpfNormalizado(atendimento.cpf);
      if (cpf.length !== 11) return;

      let pessoa = db.pessoas.find(item => cpfNormalizado(item.cpf) === cpf);
      if (!pessoa) {
        pessoa = {
          id: proximoId(db.pessoas),
          nome: atendimento.nome || "",
          cpf: atendimento.cpf,
          nome_mae: atendimento.nome_mae || "",
          estado_civil: atendimento.estado_civil || "",
          sexo: atendimento.sexo || "",
          tipo: atendimento.tipo || "Geral",
          endereco: atendimento.endereco || "",
          telefone: atendimento.telefone || "",
          email: atendimento.email || "",
          contato_emergencia: atendimento.contato_emergencia || "",
          historicoMedico: atendimento.historicoMedico || "",
          doencasPreexistentes: atendimento.doencasPreexistentes || "",
          alergias: Array.isArray(atendimento.alergias) ? [...atendimento.alergias] : [],
          createdAt: atendimento.createdAt || agora(),
          updatedAt: atendimento.updatedAt || atendimento.createdAt || agora()
        };
        db.pessoas.push(pessoa);
        alterado = true;
      } else {
        const alergiasAtendimento = Array.isArray(atendimento.alergias) ? atendimento.alergias : [];
        const alergias = [...new Set([...(pessoa.alergias || []), ...alergiasAtendimento])];
        if (alergias.length !== (pessoa.alergias || []).length) {
          pessoa.alergias = alergias;
          alterado = true;
        }

        const dataAtendimento = Date.parse(atendimento.updatedAt || atendimento.createdAt || 0);
        const dataPerfil = Date.parse(pessoa.updatedAt || pessoa.createdAt || 0);
        if (Number.isFinite(dataAtendimento) && dataAtendimento >= dataPerfil) {
          [
            "nome", "nome_mae", "estado_civil", "sexo", "tipo",
            "endereco", "telefone", "email", "contato_emergencia",
            "historicoMedico", "doencasPreexistentes"
          ].forEach(campo => {
            if (atendimento[campo] && pessoa[campo] !== atendimento[campo]) {
              pessoa[campo] = atendimento[campo];
              alterado = true;
            }
          });
          pessoa.updatedAt = atendimento.updatedAt || atendimento.createdAt || pessoa.updatedAt;
        }
      }

      if (Number(atendimento.pessoaId) !== Number(pessoa.id)) {
        atendimento.pessoaId = pessoa.id;
        alterado = true;
      }
    });

  return alterado;
}

function formatarPessoaParaUsuario(pessoa, tipoUsuario) {
  if (tipoUsuario !== "atendimento") return pessoa;

  const {
    id, nome, cpf, nome_mae, estado_civil, sexo, tipo,
    endereco, telefone, email, contato_emergencia, updatedAt
  } = pessoa;
  return {
    id, nome, cpf, nome_mae, estado_civil, sexo, tipo,
    endereco, telefone, email, contato_emergencia, updatedAt
  };
}

// =====================================================
// BANCO DE DADOS LOCAL (JSON)
// =====================================================

function writeDB(data) {
  // Grava em arquivo temporário e renomeia: evita corromper o db.json
  // caso o processo seja interrompido no meio da escrita.
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    if (DB_FILE !== SEED_FILE && fs.existsSync(SEED_FILE)) {
      fs.copyFileSync(SEED_FILE, DB_FILE);
    } else {
      writeDB(clone(defaultDB));
    }
  }

  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

  for (const chave of Object.keys(defaultDB)) {
    if (!Array.isArray(db[chave])) db[chave] = [];
  }

  let bancoMigrado = false;
  db.usuarios.forEach(usuario => {
    if (typeof usuario.senha === "string" && !usuario.senha.startsWith("scrypt$")) {
      usuario.senha = hashSenha(usuario.senha);
      bancoMigrado = true;
    }
    if (!texto(usuario.nomePadrao)) {
      usuario.nomePadrao = nomeDe(usuario);
      bancoMigrado = true;
    }
  });
  if (bancoMigrado) writeDB(db);

  return db;
}

// Procura paciente pelo ID (prioridade) e só depois pelo nome
function acharPaciente(db, id, nome) {
  const idNum = Number(id);

  if (Number.isFinite(idNum) && idNum > 0) {
    const porId = db.pacientes.find(p => Number(p.id) === idNum);
    if (porId) return porId;
  }

  if (typeof nome === "string" && nome.trim()) {
    return db.pacientes.find(p => p.nome === nome.trim());
  }

  return undefined;
}

function exigirPaciente(db, id, nome, statusEsperado, mensagemStatus) {
  const paciente = acharPaciente(db, id, nome);
  if (!paciente) throw new ErroHttp(404, "Paciente não encontrado.");
  if (statusEsperado && paciente.status !== statusEsperado) {
    throw new ErroHttp(409, mensagemStatus);
  }
  return paciente;
}

// Histórico de entrada/saída/ajuste do estoque
function registrarMovimento(db, item, tipo, quantidade, saldoAnterior, observacao, funcionario) {
  db.movimentacoes.push({
    id: novoId(),
    medicacaoId: item.id,
    medicacao: item.nome,
    tipo,
    quantidade,
    saldoAnterior,
    saldoAtual: Number(item.quantidade) || 0,
    observacao: observacao || "",
    funcionario,
    createdAt: agora()
  });

  if (db.movimentacoes.length > 1000) {
    db.movimentacoes = db.movimentacoes.slice(-1000);
  }
}

// =====================================================
// SENHAS E SESSÃO
// =====================================================

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(senha, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function iguaisSeguro(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function conferirSenha(senha, guardada) {
  if (typeof guardada !== "string") return false;

  // Senhas antigas (texto puro) ainda funcionam e são convertidas no login
  if (!guardada.startsWith("scrypt$")) return iguaisSeguro(senha, guardada);

  const [, salt, hash] = guardada.split("$");
  const calculado = crypto.scryptSync(senha, salt, 64);
  const esperado = Buffer.from(hash, "hex");
  return calculado.length === esperado.length && crypto.timingSafeEqual(calculado, esperado);
}

function obterSegredo() {
  if (process.env.SESSION_SECRET !== undefined) {
    if (process.env.SESSION_SECRET.length < 32) {
      throw new Error("SESSION_SECRET deve ter pelo menos 32 caracteres.");
    }
    return process.env.SESSION_SECRET;
  }
  if (EM_VERCEL) {
    throw new Error("Configure SESSION_SECRET no ambiente de implantação.");
  }

  const arquivo = path.join(DATA_DIR, ".session-secret");
  if (fs.existsSync(arquivo)) {
    const segredo = fs.readFileSync(arquivo, "utf8").trim();
    if (segredo.length < 32) throw new Error("O segredo local da sessão é inválido.");
    return segredo;
  }

  const novo = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(arquivo, novo, { mode: 0o600 });
  return novo;
}

const SEGREDO = obterSegredo();

const assinar = conteudo =>
  crypto.createHmac("sha256", SEGREDO).update(conteudo).digest("base64url");

function criarToken(user) {
  const corpo = Buffer.from(
    JSON.stringify({ u: user.usuario, exp: Date.now() + VALIDADE_TOKEN_MS })
  ).toString("base64url");
  return `${corpo}.${assinar(corpo)}`;
}

function lerToken(token) {
  if (typeof token !== "string") return null;

  const [corpo, assinatura] = token.split(".");
  if (!corpo || !assinatura) return null;

  const a = Buffer.from(assinatura);
  const b = Buffer.from(assinar(corpo));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const dados = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
    return dados.exp && dados.exp > Date.now() ? dados : null;
  } catch {
    return null;
  }
}

// Exige login válido. O usuário é relido do banco a cada chamada, então
// excluir ou renomear um usuário vale imediatamente.
function autenticar(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  const dados = m && lerToken(m[1]);
  const user = dados && readDB().usuarios.find(u => u.usuario === dados.u);

  if (!user) {
    return res.status(401).json({ erro: "Sessão expirada. Faça login novamente." });
  }

  req.user = publico(user);
  next();
}

// Exige login + setor permitido (administrador sempre pode)
function exigir(...tipos) {
  return [
    autenticar,
    (req, res, next) => {
      if (req.user.tipo === "admin" || tipos.includes(req.user.tipo)) return next();
      return res.status(403).json({ erro: "Você não tem permissão para esta operação." });
    }
  ];
}

// Limita tentativas de login (5 erros por minuto para o mesmo IP + usuário)
const tentativas = new Map();
const MAX_TENTATIVAS = 5;
const JANELA_MS = 60 * 1000;

function loginBloqueado(chave) {
  const t = tentativas.get(chave);
  if (!t) return false;
  if (Date.now() - t.inicio > JANELA_MS) {
    tentativas.delete(chave);
    return false;
  }
  return t.falhas >= MAX_TENTATIVAS;
}

function registrarFalhaLogin(chave) {
  const t = tentativas.get(chave);
  if (!t || Date.now() - t.inicio > JANELA_MS) {
    tentativas.set(chave, { inicio: Date.now(), falhas: 1 });
  } else {
    t.falhas += 1;
  }
}

// =====================================================
// ARQUIVOS DO FRONTEND
// =====================================================

app.use(express.static(frontendPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// =====================================================
// API - LOGIN E SESSÃO
// =====================================================

function responderLogin(req, res, acessoAdmin) {
  const { usuario, senha } = req.body || {};

  if (typeof usuario !== "string" || typeof senha !== "string") {
    throw new ErroHttp(400, "Informe o usuário e a senha.");
  }

  const chave = `${req.ip}|${usuario.trim().toLowerCase()}`;

  if (loginBloqueado(chave)) {
    throw new ErroHttp(429, "Muitas tentativas. Aguarde 1 minuto e tente novamente.");
  }

  const db = readDB();
  const user = db.usuarios.find(u => mesmoLogin(u.usuario, usuario.trim()));
  const senhaValida = user && conferirSenha(senha, user.senha);
  const tipoPermitido = user && (acessoAdmin
    ? user.tipo === "admin"
    : user.tipo !== "admin");
  if (!user || !senhaValida || !tipoPermitido) {
    registrarFalhaLogin(chave);
    throw new ErroHttp(401, "Usuário ou senha incorretos.");
  }

  tentativas.delete(chave);

  // Converte senha antiga (texto puro) para hash
  if (!String(user.senha).startsWith("scrypt$")) {
    user.senha = hashSenha(senha);
    writeDB(db);
  }

  res.json({ ...perfilDoUsuario(user), token: criarToken(user) });
}

app.post("/login", (req, res) => {
  responderLogin(req, res, false);
});

app.post("/login/admin", (req, res) => {
  responderLogin(req, res, true);
});

app.get("/sessao", autenticar, (req, res) => {
  const user = readDB().usuarios.find(item => mesmoLogin(item.usuario, req.user.usuario));
  if (!user) throw new ErroHttp(401, "Sessão expirada. Faça login novamente.");
  res.json(perfilDoUsuario(user));
});

function lerFotoPerfil(valor, fotoAtual) {
  if (valor === undefined) return fotoAtual || null;
  if (valor === null || valor === "") return null;

  const partes = typeof valor === "string"
    ? /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(valor)
    : null;
  if (!partes) {
    throw new ErroHttp(400, "A foto deve estar no formato JPEG, PNG ou WebP.");
  }

  const buffer = Buffer.from(partes[2], "base64");
  if (buffer.length > 512 * 1024 || buffer.toString("base64") !== partes[2]) {
    throw new ErroHttp(400, "A foto deve ser válida e ter no máximo 512 KB.");
  }

  const assinaturaValida = {
    jpeg: buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    png: buffer.length >= 8 && buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ),
    webp: buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
  }[partes[1]];

  if (!assinaturaValida) {
    throw new ErroHttp(400, "O conteúdo do arquivo não corresponde ao formato da foto.");
  }

  return valor;
}

function usuarioDoPerfil(db, req, login) {
  if (req.user.tipo !== "admin" && !mesmoLogin(req.user.usuario, login)) {
    throw new ErroHttp(403, "Você só pode acessar ou alterar o próprio perfil.");
  }

  const user = db.usuarios.find(item => mesmoLogin(item.usuario, login));
  if (!user) throw new ErroHttp(404, "Perfil não encontrado.");
  return user;
}

function atualizarPerfil(db, user, body, responsavel) {
  const nome = texto(body.nome) || nomePadraoDe(user);
  if (nome.length > 120) {
    throw new ErroHttp(400, "Informe um nome válido de até 120 caracteres.");
  }

  user.nome = nome;
  user.fotoPerfil = lerFotoPerfil(body.fotoPerfil, user.fotoPerfil);
  registrarAuditoria(db, responsavel, "atualizar_perfil", "usuario", user.usuario);
  writeDB(db);
  return perfilDoUsuario(user);
}

app.get("/perfil", autenticar, (req, res) => {
  const db = readDB();
  const user = usuarioDoPerfil(db, req, req.user.usuario);
  res.json(perfilDoUsuario(user));
});

app.put("/perfil", autenticar, (req, res) => {
  const body = req.body || {};
  const db = readDB();
  const user = usuarioDoPerfil(db, req, req.user.usuario);
  res.json(atualizarPerfil(db, user, body, req.user.nome));
});

app.get("/usuarios/:usuario/perfil", autenticar, (req, res) => {
  const db = readDB();
  const user = usuarioDoPerfil(db, req, req.params.usuario);
  res.json(perfilDoUsuario(user));
});

app.put("/usuarios/:usuario/perfil", autenticar, (req, res) => {
  const db = readDB();
  const user = usuarioDoPerfil(db, req, req.params.usuario);
  res.json(atualizarPerfil(db, user, req.body || {}, req.user.nome));
});

// =====================================================
// API - USUÁRIOS (somente administrador)
// =====================================================

function lerDadosUsuario(body, senhaObrigatoria) {
  const { usuario, nome, senha, tipo } = body || {};
  const login = texto(usuario);
  const nomeFuncionario = texto(nome);
  const tipoUsuario = texto(tipo);

  if (!login || !nomeFuncionario || !tipoUsuario) {
    throw new ErroHttp(400, "Informe o nome do funcionário, o usuário (login) e o setor.");
  }

  if (login.length > 100 || nomeFuncionario.length > 120) {
    throw new ErroHttp(400, "Nome ou usuário grande demais.");
  }

  if (!TIPOS_PERMITIDOS.includes(tipoUsuario)) {
    throw new ErroHttp(400, "Selecione um setor válido.");
  }

  if (senha !== undefined && typeof senha !== "string") {
    throw new ErroHttp(400, "A senha informada é inválida.");
  }

  if (senhaObrigatoria && !(senha || "").trim()) {
    throw new ErroHttp(400, "Informe a senha.");
  }

  return { login, nomeFuncionario, tipoUsuario, senha };
}

app.get("/usuarios", ...exigir(), (req, res) => {
  res.json(readDB().usuarios.map(publico));
});

app.post("/usuarios", ...exigir(), (req, res) => {
  const { login, nomeFuncionario, tipoUsuario, senha } = lerDadosUsuario(req.body, true);
  const db = readDB();

  if (db.usuarios.some(u => mesmoLogin(u.usuario, login))) {
    throw new ErroHttp(409, "Esse nome de usuário já está cadastrado.");
  }

  const novo = {
    usuario: login,
    nome: nomeFuncionario,
    nomePadrao: nomeFuncionario,
    senha: hashSenha(senha),
    tipo: tipoUsuario
  };

  db.usuarios.push(novo);
  registrarAuditoria(db, req.user.nome, "criar", "usuario", novo.usuario);
  writeDB(db);

  res.status(201).json({ sucesso: true, usuario: publico(novo) });
});

app.put("/usuarios/:usuario", ...exigir(), (req, res) => {
  const { login, nomeFuncionario, tipoUsuario, senha } = lerDadosUsuario(req.body, false);
  const db = readDB();

  const indice = db.usuarios.findIndex(u => mesmoLogin(u.usuario, req.params.usuario));
  if (indice === -1) throw new ErroHttp(404, "Usuário não encontrado.");

  const duplicado = db.usuarios.some((u, i) => i !== indice && mesmoLogin(u.usuario, login));
  if (duplicado) throw new ErroHttp(409, "Esse nome de usuário já está cadastrado.");

  const atual = db.usuarios[indice];

  if (atual.tipo === "admin" && tipoUsuario !== "admin" && contarAdmins(db) <= 1) {
    throw new ErroHttp(400, "Mantenha pelo menos um administrador cadastrado.");
  }

  const atualizado = {
    ...atual,
    usuario: login,
    nome: nomeFuncionario,
    nomePadrao: nomeFuncionario,
    tipo: tipoUsuario
  };

  // Senha vazia = mantém a senha atual
  if (typeof senha === "string" && senha.length > 0) {
    atualizado.senha = hashSenha(senha);
  }

  db.usuarios[indice] = atualizado;
  registrarAuditoria(db, req.user.nome, "atualizar", "usuario", atualizado.usuario);
  writeDB(db);

  const resposta = { sucesso: true, usuario: publico(atualizado) };

  // Se o administrador editou a si mesmo, devolve uma sessão nova
  // (o login pode ter mudado e o token antigo deixaria de valer).
  if (mesmoLogin(atual.usuario, req.user.usuario)) {
    resposta.novaSessao = { ...perfilDoUsuario(atualizado), token: criarToken(atualizado) };
  }

  res.json(resposta);
});

app.delete("/usuarios/:usuario", ...exigir(), (req, res) => {
  const db = readDB();

  const indice = db.usuarios.findIndex(u => mesmoLogin(u.usuario, req.params.usuario));
  if (indice === -1) throw new ErroHttp(404, "Usuário não encontrado.");

  const alvo = db.usuarios[indice];

  if (mesmoLogin(alvo.usuario, req.user.usuario)) {
    throw new ErroHttp(400, "Você não pode excluir o seu próprio usuário.");
  }

  if (alvo.tipo === "admin" && contarAdmins(db) <= 1) {
    throw new ErroHttp(400, "Mantenha pelo menos um administrador cadastrado.");
  }

  db.usuarios.splice(indice, 1);
  registrarAuditoria(db, req.user.nome, "excluir", "usuario", alvo.usuario);
  writeDB(db);

  res.json({ sucesso: true, mensagem: "Usuário excluído com sucesso." });
});

// =====================================================
// API - PLANTÕES (somente administrador)
// =====================================================

const SETORES_PLANTAO = [
  "medico",
  "enfermagem",
  "tecnico_enfermagem",
  "laboratorio",
  "triagem",
  "atendimento",
  "medicacao",
  "outro"
];

function lerDadosPlantao(body) {
  const profissional = texto(body && body.profissional);
  const setor = texto(body && body.setor);
  const data = texto(body && body.data);
  const inicio = texto(body && body.inicio);
  const fim = texto(body && body.fim);
  const observacoes = texto(body && body.observacoes);

  if (!profissional || !data || !inicio || !fim || !setor) {
    throw new ErroHttp(400, "Preencha profissional, setor, data e horários.");
  }

  if (profissional.length > 120 || observacoes.length > 500) {
    throw new ErroHttp(400, "Profissional ou observações excedem o limite permitido.");
  }

  const dataObjeto = new Date(`${data}T00:00:00.000Z`);
  const dataValida = /^\d{4}-\d{2}-\d{2}$/.test(data) &&
    Number.isFinite(dataObjeto.getTime()) &&
    dataObjeto.toISOString().slice(0, 10) === data;
  const horarioValido = horario => /^([01]\d|2[0-3]):[0-5]\d$/.test(horario);

  if (!dataValida || !horarioValido(inicio) || !horarioValido(fim) || inicio === fim) {
    throw new ErroHttp(400, "Informe uma data e horários válidos; plantões podem atravessar a meia-noite.");
  }

  if (!SETORES_PLANTAO.includes(setor)) {
    throw new ErroHttp(400, "Selecione um setor válido.");
  }

  return { profissional, setor, data, inicio, fim, observacoes };
}

app.get("/plantoes", ...exigir(), (req, res) => {
  const plantoes = readDB().plantoes.slice().sort((a, b) =>
    a.data.localeCompare(b.data) || a.inicio.localeCompare(b.inicio)
  );
  res.json(plantoes);
});

app.post("/plantoes", ...exigir(), (req, res) => {
  const dados = lerDadosPlantao(req.body);
  const db = readDB();
  const plantao = { id: novoId(), ...dados, createdAt: agora() };

  db.plantoes.push(plantao);
  registrarAuditoria(db, req.user.nome, "criar", "plantao", plantao.id);
  writeDB(db);

  res.status(201).json({ sucesso: true, plantao });
});

app.delete("/plantoes/:id", ...exigir(), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ErroHttp(400, "Plantão inválido.");
  }

  const db = readDB();
  const indice = db.plantoes.findIndex(plantao => Number(plantao.id) === id);
  if (indice === -1) throw new ErroHttp(404, "Plantão não encontrado.");

  db.plantoes.splice(indice, 1);
  registrarAuditoria(db, req.user.nome, "excluir", "plantao", id);
  writeDB(db);

  res.json({ sucesso: true });
});

// =====================================================
// API - ATENDIMENTO
// =====================================================

function salvarFoto(dataUrl, id) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new ErroHttp(400, "Foto inválida.");

  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > 1.5 * 1024 * 1024) throw new ErroHttp(400, "A foto é grande demais.");

  try {
    const pasta = path.join(frontendPath, "uploads");
    fs.mkdirSync(pasta, { recursive: true });

    const arquivo = `${id}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
    fs.writeFileSync(path.join(pasta, arquivo), buffer);
    return `uploads/${arquivo}`;
  } catch (erro) {
    // Disco somente leitura (ex.: Vercel): guarda a imagem dentro do próprio registro
    console.warn("Não foi possível salvar a foto em arquivo:", erro.message);
    return dataUrl;
  }
}

function lerDadosPessoa(body, atual, usuario) {
  const dados = body || {};
  const nome = texto(dados.nome);
  const cpf = texto(dados.cpf);
  const email = texto(dados.email);
  const camposTexto = {
    nome_mae: texto(dados.nome_mae),
    estado_civil: texto(dados.estado_civil),
    sexo: texto(dados.sexo),
    tipo: texto(dados.tipo),
    endereco: texto(dados.endereco),
    telefone: texto(dados.telefone),
    email,
    contato_emergencia: texto(dados.contato_emergencia)
  };

  if (!nome || nome.length > 150) {
    throw new ErroHttp(400, "Informe um nome válido para o paciente.");
  }
  if (!/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(cpf)) {
    throw new ErroHttp(400, "Informe o CPF no formato 000.000.000-00.");
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ErroHttp(400, "Informe um email válido.");
  }
  const limites = {
    nome_mae: 150,
    estado_civil: 40,
    sexo: 40,
    tipo: 40,
    endereco: 200,
    telefone: 30,
    email: 150,
    contato_emergencia: 150
  };
  if (Object.entries(limites).some(([campo, limite]) => camposTexto[campo].length > limite)) {
    throw new ErroHttp(400, "Um ou mais campos do cadastro excederam o limite permitido.");
  }

  const campos = {
    nome,
    cpf,
    ...camposTexto,
    tipo: camposTexto.tipo || "Geral"
  };

  if (["admin", "medico", "triagem"].includes(usuario.tipo)) {
    const alergias = texto(dados.alergias);
    const historicoMedico = texto(dados.historicoMedico);
    const doencasPreexistentes = texto(dados.doencasPreexistentes);
    if (alergias.length > 1000 || historicoMedico.length > 2000 || doencasPreexistentes.length > 1000) {
      throw new ErroHttp(400, "As informações clínicas excedem o limite permitido.");
    }

    campos.alergias = [...new Set(alergias.split(/[,;]+/).map(item => item.trim()).filter(Boolean))];
    campos.historicoMedico = historicoMedico;
    campos.doencasPreexistentes = doencasPreexistentes;
  } else if (atual) {
    campos.alergias = atual.alergias || [];
    campos.historicoMedico = atual.historicoMedico || "";
    campos.doencasPreexistentes = atual.doencasPreexistentes || "";
  } else {
    campos.alergias = [];
    campos.historicoMedico = "";
    campos.doencasPreexistentes = "";
  }

  return campos;
}

app.get("/pessoas", ...exigir("atendimento", "medico", "triagem"), (req, res) => {
  const busca = texto(req.query.busca);
  if (busca.length < 2) return res.json([]);

  const db = readDB();
  migrarPessoasLegadas(db);
  const nomeBusca = busca.toLocaleLowerCase("pt-BR");
  const cpfBusca = cpfNormalizado(busca);
  const pessoas = db.pessoas
    .filter(pessoa =>
      texto(pessoa.nome).toLocaleLowerCase("pt-BR").includes(nomeBusca) ||
      (cpfBusca.length >= 3 && cpfNormalizado(pessoa.cpf).includes(cpfBusca))
    )
    .sort((a, b) => texto(a.nome).localeCompare(texto(b.nome), "pt-BR"))
    .slice(0, 100)
    .map(pessoa => formatarPessoaParaUsuario(pessoa, req.user.tipo));

  registrarAuditoria(db, req.user.nome, "consultar_busca", "pessoas");
  writeDB(db);
  res.json(pessoas);
});

app.post("/pessoas", ...exigir("atendimento", "medico", "triagem"), (req, res) => {
  const dados = lerDadosPessoa(req.body, null, req.user);
  const db = readDB();
  migrarPessoasLegadas(db);

  if (db.pessoas.some(pessoa => cpfNormalizado(pessoa.cpf) === cpfNormalizado(dados.cpf))) {
    throw new ErroHttp(409, "Já existe um cadastro para esse CPF. Pesquise e edite o paciente.");
  }

  const pessoa = {
    id: proximoId(db.pessoas),
    ...dados,
    createdAt: agora(),
    updatedAt: agora()
  };
  db.pessoas.push(pessoa);
  registrarAuditoria(db, req.user.nome, "criar", "pessoa", pessoa.id);
  writeDB(db);
  res.status(201).json(formatarPessoaParaUsuario(pessoa, req.user.tipo));
});

app.put("/pessoas/:id", ...exigir("atendimento", "medico", "triagem"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Paciente inválido.");

  const db = readDB();
  migrarPessoasLegadas(db);
  const pessoa = db.pessoas.find(item => Number(item.id) === id);
  if (!pessoa) throw new ErroHttp(404, "Paciente não encontrado.");

  const dados = lerDadosPessoa(req.body, pessoa, req.user);
  if (cpfNormalizado(dados.cpf) !== cpfNormalizado(pessoa.cpf)) {
    throw new ErroHttp(400, "O CPF não pode ser alterado neste cadastro.");
  }

  Object.assign(pessoa, dados, { updatedAt: agora() });
  db.pacientes
    .filter(atendimento => Number(atendimento.pessoaId) === id)
    .forEach(atendimento => {
      Object.assign(atendimento, dados);
      atendimento.pessoaId = id;
    });
  registrarAuditoria(db, req.user.nome, "editar", "pessoa", id);
  writeDB(db);
  res.json(formatarPessoaParaUsuario(pessoa, req.user.tipo));
});

function dataAgendaValida(data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
  const [ano, mes, dia] = data.split("-").map(Number);
  const dataUtc = new Date(Date.UTC(ano, mes - 1, dia));
  return dataUtc.getUTCFullYear() === ano &&
    dataUtc.getUTCMonth() === mes - 1 &&
    dataUtc.getUTCDate() === dia;
}

app.get("/agenda/medicos", ...exigir("atendimento", "medico"), (req, res) => {
  const db = readDB();
  const medicos = db.usuarios
    .filter(usuario =>
      usuario.tipo === "medico" &&
      (req.user.tipo !== "medico" || mesmoLogin(usuario.usuario, req.user.usuario))
    )
    .map(usuario => ({ usuario: usuario.usuario, nome: nomeDe(usuario) }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  res.json(medicos);
});

app.get("/agendamentos", ...exigir("atendimento", "medico"), (req, res) => {
  const data = texto(req.query.data);
  const medicoFiltro = texto(req.query.medico);
  const statusFiltro = texto(req.query.status);
  if (data && !dataAgendaValida(data)) throw new ErroHttp(400, "A data informada é inválida.");
  if (statusFiltro && !["agendada", "confirmada", "cancelada", "concluida"].includes(statusFiltro)) {
    throw new ErroHttp(400, "O status informado é inválido.");
  }

  const db = readDB();
  const pessoas = new Map(db.pessoas.map(pessoa => [Number(pessoa.id), pessoa]));
  const usuarios = new Map(db.usuarios.map(usuario => [usuario.usuario.toLowerCase(), usuario]));
  const agendamentos = db.agendamentos
    .filter(item =>
      (!data || item.data === data) &&
      (!medicoFiltro || mesmoLogin(item.medico, medicoFiltro)) &&
      (!statusFiltro || item.status === statusFiltro) &&
      (req.user.tipo !== "medico" || mesmoLogin(item.medico, req.user.usuario))
    )
    .sort((a, b) => `${a.data}T${a.hora}`.localeCompare(`${b.data}T${b.hora}`))
    .map(item => ({
      ...item,
      paciente: pessoas.get(Number(item.pessoaId))?.nome || "Paciente não encontrado",
      medicoNome: nomeDe(usuarios.get(String(item.medico).toLowerCase()) || { usuario: item.medico })
    }));

  registrarAuditoria(db, req.user.nome, "consultar", "agendamentos");
  writeDB(db);
  res.json(agendamentos);
});

app.post("/agendamentos", ...exigir("atendimento"), (req, res) => {
  const body = req.body || {};
  const pessoaId = Number(body.pessoaId);
  const medicoLogin = texto(body.medico);
  const data = texto(body.data);
  const hora = texto(body.hora);
  const motivo = texto(body.motivo);

  if (!Number.isSafeInteger(pessoaId) || pessoaId <= 0) throw new ErroHttp(400, "Selecione um paciente.");
  if (!dataAgendaValida(data)) throw new ErroHttp(400, "Informe uma data válida.");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new ErroHttp(400, "Informe um horário válido.");
  if (new Date(`${data}T${hora}:00`).getTime() <= Date.now()) {
    throw new ErroHttp(400, "Não é possível agendar uma consulta em um horário passado.");
  }
  if (!motivo || motivo.length > 500) throw new ErroHttp(400, "Informe o motivo da consulta (até 500 caracteres).");

  const db = readDB();
  migrarPessoasLegadas(db);
  const pessoa = db.pessoas.find(item => Number(item.id) === pessoaId);
  if (!pessoa) throw new ErroHttp(404, "Paciente não encontrado.");
  const medico = db.usuarios.find(usuario =>
    usuario.tipo === "medico" && mesmoLogin(usuario.usuario, medicoLogin)
  );
  if (!medico) throw new ErroHttp(400, "Selecione um médico cadastrado.");

  const conflito = db.agendamentos.some(item =>
    item.data === data &&
    item.hora === hora &&
    item.status !== "cancelada" &&
    (mesmoLogin(item.medico, medico.usuario) || Number(item.pessoaId) === pessoaId)
  );
  if (conflito) {
    throw new ErroHttp(409, "O horário já está ocupado para este médico ou paciente.");
  }

  const agendamento = {
    id: novoId(),
    pessoaId,
    medico: medico.usuario,
    data,
    hora,
    motivo,
    status: "agendada",
    criadoPor: req.user.nome,
    createdAt: agora(),
    updatedAt: agora()
  };
  db.agendamentos.push(agendamento);
  registrarAuditoria(db, req.user.nome, "criar", "agendamento", agendamento.id);
  writeDB(db);
  res.status(201).json({
    ...agendamento,
    paciente: pessoa.nome,
    medicoNome: nomeDe(medico)
  });
});

app.patch("/agendamentos/:id", ...exigir("atendimento", "medico"), (req, res) => {
  const id = Number(req.params.id);
  const status = texto(req.body && req.body.status);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Agendamento inválido.");
  if (!["confirmada", "cancelada", "concluida"].includes(status)) {
    throw new ErroHttp(400, "Status de agendamento inválido.");
  }

  const db = readDB();
  const agendamento = db.agendamentos.find(item => Number(item.id) === id);
  if (!agendamento) throw new ErroHttp(404, "Agendamento não encontrado.");
  if (req.user.tipo === "medico" && !mesmoLogin(agendamento.medico, req.user.usuario)) {
    throw new ErroHttp(403, "Você só pode atualizar seus próprios agendamentos.");
  }
  if (req.user.tipo === "medico" && status === "cancelada") {
    throw new ErroHttp(403, "A equipe de atendimento deve cancelar o agendamento.");
  }

  const transicoes = {
    agendada: ["confirmada", "cancelada"],
    confirmada: ["concluida", "cancelada"],
    cancelada: [],
    concluida: []
  };
  if (agendamento.status !== status && !transicoes[agendamento.status]?.includes(status)) {
    throw new ErroHttp(409, "Não é possível alterar o status atual do agendamento.");
  }

  agendamento.status = status;
  agendamento.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "alterar_status", "agendamento", id);
  writeDB(db);
  res.json(agendamento);
});

// =====================================================
// API - INTERNAÇÃO E LEITOS
// =====================================================

function internacaoAtivaNoLeito(db, leitoId) {
  return db.internacoes.find(internacao =>
    internacao.status === "ativa" && Number(internacao.leitoId) === Number(leitoId)
  );
}

function internacaoAtivaDaPessoa(db, pessoaId) {
  return db.internacoes.find(internacao =>
    internacao.status === "ativa" && Number(internacao.pessoaId) === Number(pessoaId)
  );
}

function formatarLeito(db, leito) {
  const internacao = internacaoAtivaNoLeito(db, leito.id);
  const pessoa = internacao &&
    db.pessoas.find(item => Number(item.id) === Number(internacao.pessoaId));

  return {
    ...leito,
    status: internacao ? "ocupado" : (leito.status || "disponivel"),
    internacaoId: internacao ? internacao.id : null,
    paciente: pessoa ? { id: pessoa.id, nome: pessoa.nome } : null
  };
}

function formatarInternacao(db, internacao) {
  const pessoa = db.pessoas.find(item => Number(item.id) === Number(internacao.pessoaId));
  const leito = db.leitos.find(item => Number(item.id) === Number(internacao.leitoId));

  return {
    ...internacao,
    paciente: pessoa ? { id: pessoa.id, nome: pessoa.nome, cpf: pessoa.cpf } : null,
    leito: leito ? {
      id: leito.id,
      quarto: leito.quarto,
      numero: leito.numero,
      setor: leito.setor
    } : null
  };
}

function exigirInternacao(db, id, somenteAtiva = true) {
  const internacao = db.internacoes.find(item => Number(item.id) === Number(id));
  if (!internacao) throw new ErroHttp(404, "Internação não encontrada.");
  if (somenteAtiva && internacao.status !== "ativa") {
    throw new ErroHttp(409, "A internação não está ativa.");
  }
  return internacao;
}

app.get("/leitos", ...exigir("medico", "enfermagem", "tecnico_enfermagem"), (req, res) => {
  const db = readDB();
  const leitos = db.leitos
    .map(leito => formatarLeito(db, leito))
    .sort((a, b) =>
      a.setor.localeCompare(b.setor, "pt-BR") ||
      a.quarto.localeCompare(b.quarto, "pt-BR", { numeric: true }) ||
      a.numero.localeCompare(b.numero, "pt-BR", { numeric: true })
    );
  res.json(leitos);
});

app.post("/leitos", ...exigir(), (req, res) => {
  const body = req.body || {};
  const quarto = texto(body.quarto);
  const numero = texto(body.numero);
  const setor = texto(body.setor);
  const tipo = texto(body.tipo) || "Geral";

  if (!quarto || quarto.length > 30 || !numero || numero.length > 30 ||
      !setor || setor.length > 60 || tipo.length > 40) {
    throw new ErroHttp(400, "Informe quarto, leito e setor com valores válidos.");
  }

  const db = readDB();
  const duplicado = db.leitos.some(leito =>
    texto(leito.quarto).toLocaleLowerCase("pt-BR") === quarto.toLocaleLowerCase("pt-BR") &&
    texto(leito.numero).toLocaleLowerCase("pt-BR") === numero.toLocaleLowerCase("pt-BR")
  );
  if (duplicado) throw new ErroHttp(409, "Este leito já está cadastrado.");

  const leito = {
    id: proximoId(db.leitos),
    quarto,
    numero,
    setor,
    tipo,
    status: "disponivel",
    createdAt: agora(),
    updatedAt: agora()
  };
  db.leitos.push(leito);
  registrarAuditoria(db, req.user.nome, "criar", "leito", leito.id);
  writeDB(db);
  res.status(201).json(formatarLeito(db, leito));
});

app.patch("/leitos/:id", ...exigir(), (req, res) => {
  const id = Number(req.params.id);
  const status = texto(req.body && req.body.status);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Leito inválido.");
  if (!["disponivel", "manutencao"].includes(status)) {
    throw new ErroHttp(400, "O leito pode ser marcado como disponível ou em manutenção.");
  }

  const db = readDB();
  const leito = db.leitos.find(item => Number(item.id) === id);
  if (!leito) throw new ErroHttp(404, "Leito não encontrado.");
  if (internacaoAtivaNoLeito(db, id)) {
    throw new ErroHttp(409, "Não é possível alterar o status de um leito ocupado.");
  }

  leito.status = status;
  leito.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "alterar_status", "leito", id);
  writeDB(db);
  res.json(formatarLeito(db, leito));
});

app.get("/internacoes/pacientes", ...exigir("medico", "enfermagem"), (req, res) => {
  const busca = texto(req.query.busca);
  if (busca.length < 2) return res.json([]);

  const db = readDB();
  migrarPessoasLegadas(db);
  const nomeBusca = busca.toLocaleLowerCase("pt-BR");
  const cpfBusca = cpfNormalizado(busca);
  const pessoas = db.pessoas
    .filter(pessoa =>
      texto(pessoa.nome).toLocaleLowerCase("pt-BR").includes(nomeBusca) ||
      (cpfBusca.length >= 3 && cpfNormalizado(pessoa.cpf).includes(cpfBusca))
    )
    .slice(0, 50)
    .map(({ id, nome, cpf }) => ({ id, nome, cpf }));

  registrarAuditoria(db, req.user.nome, "consultar_busca", "pacientes_para_internacao");
  writeDB(db);
  res.json(pessoas);
});

app.get("/internacoes", ...exigir("medico", "enfermagem", "tecnico_enfermagem", "centro_cirurgico"), (req, res) => {
  const filtro = texto(req.query.status || "ativa");
  if (!["ativa", "alta", "todas"].includes(filtro)) {
    throw new ErroHttp(400, "Selecione um filtro de internação válido.");
  }

  const db = readDB();
  const internacoes = db.internacoes
    .filter(item => filtro === "todas" || item.status === filtro)
    .sort((a, b) => Date.parse(b.admitidoEm) - Date.parse(a.admitidoEm))
    .map(item => formatarInternacao(db, item));
  registrarAuditoria(db, req.user.nome, "consultar", "internacoes");
  writeDB(db);
  res.json(internacoes);
});

app.post("/internacoes", ...exigir("medico", "enfermagem"), (req, res) => {
  const body = req.body || {};
  const pessoaId = Number(body.pessoaId);
  const leitoId = Number(body.leitoId);
  const motivo = texto(body.motivo);

  if (!Number.isSafeInteger(pessoaId) || pessoaId <= 0) {
    throw new ErroHttp(400, "Selecione um paciente cadastrado.");
  }
  if (!Number.isSafeInteger(leitoId) || leitoId <= 0) {
    throw new ErroHttp(400, "Selecione um leito disponível.");
  }
  if (!motivo || motivo.length > 1000) {
    throw new ErroHttp(400, "Informe o motivo da internação (até 1000 caracteres).");
  }

  const db = readDB();
  migrarPessoasLegadas(db);
  const pessoa = db.pessoas.find(item => Number(item.id) === pessoaId);
  if (!pessoa) throw new ErroHttp(404, "Paciente não encontrado.");
  if (internacaoAtivaDaPessoa(db, pessoaId)) {
    throw new ErroHttp(409, "Este paciente já possui uma internação ativa.");
  }

  const leito = db.leitos.find(item => Number(item.id) === leitoId);
  if (!leito) throw new ErroHttp(404, "Leito não encontrado.");
  if (leito.status === "manutencao" || internacaoAtivaNoLeito(db, leitoId)) {
    throw new ErroHttp(409, "O leito selecionado não está disponível.");
  }

  const internacao = {
    id: novoId(),
    pessoaId,
    leitoId,
    motivo,
    status: "ativa",
    admitidoEm: agora(),
    admitidoPor: req.user.nome,
    transferencias: [],
    createdAt: agora(),
    updatedAt: agora()
  };
  db.internacoes.push(internacao);
  registrarAuditoria(db, req.user.nome, "admitir", "internacao", internacao.id);
  writeDB(db);
  res.status(201).json(formatarInternacao(db, internacao));
});

app.post("/internacoes/:id/transferencia", ...exigir("medico", "enfermagem"), (req, res) => {
  const id = Number(req.params.id);
  const leitoId = Number(req.body && req.body.leitoId);
  const motivo = texto(req.body && req.body.motivo);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(leitoId) || leitoId <= 0) {
    throw new ErroHttp(400, "Internação ou leito inválido.");
  }
  if (motivo.length > 500) throw new ErroHttp(400, "O motivo excede o limite permitido.");

  const db = readDB();
  const internacao = exigirInternacao(db, id);
  const destino = db.leitos.find(item => Number(item.id) === leitoId);
  if (!destino) throw new ErroHttp(404, "Leito de destino não encontrado.");
  if (Number(internacao.leitoId) === leitoId) {
    throw new ErroHttp(409, "O paciente já está neste leito.");
  }
  if (destino.status === "manutencao" || internacaoAtivaNoLeito(db, leitoId)) {
    throw new ErroHttp(409, "O leito de destino não está disponível.");
  }

  const origem = db.leitos.find(item => Number(item.id) === Number(internacao.leitoId));
  internacao.transferencias = Array.isArray(internacao.transferencias) ? internacao.transferencias : [];
  internacao.transferencias.push({
    deLeitoId: internacao.leitoId,
    de: origem ? `${origem.quarto}-${origem.numero}` : "Leito anterior",
    paraLeitoId: destino.id,
    para: `${destino.quarto}-${destino.numero}`,
    motivo,
    profissional: req.user.nome,
    createdAt: agora()
  });
  internacao.leitoId = destino.id;
  internacao.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "transferir", "internacao", id);
  writeDB(db);
  res.json(formatarInternacao(db, internacao));
});

app.post("/internacoes/:id/alta", ...exigir("medico"), (req, res) => {
  const id = Number(req.params.id);
  const motivo = texto(req.body && req.body.motivo);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Internação inválida.");
  if (!motivo || motivo.length > 1000) {
    throw new ErroHttp(400, "Informe o resumo ou motivo da alta (até 1000 caracteres).");
  }

  const db = readDB();
  const internacao = exigirInternacao(db, id);
  internacao.status = "alta";
  internacao.altaEm = agora();
  internacao.altaPor = req.user.nome;
  internacao.resumoAlta = motivo;
  internacao.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "dar_alta", "internacao", id);
  writeDB(db);
  res.json(formatarInternacao(db, internacao));
});

// =====================================================
// API - REGISTROS DE ENFERMAGEM
// =====================================================

function numeroClinico(valor, nome, minimo, maximo, inteiro = false) {
  if (valor === undefined || valor === null || valor === "") return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < minimo || numero > maximo ||
      (inteiro && !Number.isInteger(numero))) {
    throw new ErroHttp(400, `Informe um valor válido para ${nome}.`);
  }
  return numero;
}

app.get("/enfermagem/registros/:internacaoId",
  ...exigir("medico", "enfermagem", "tecnico_enfermagem"),
  (req, res) => {
    const id = Number(req.params.internacaoId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Internação inválida.");

    const db = readDB();
    exigirInternacao(db, id, false);
    const recentes = registros => registros
      .filter(item => Number(item.internacaoId) === id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const fluidos = recentes(db.balancosHidricos);
    const limite24h = Date.now() - 24 * 60 * 60 * 1000;
    const fluidos24h = fluidos.filter(item => Date.parse(item.createdAt) >= limite24h);
    const totalEntrada = fluidos24h
      .filter(item => item.tipo === "entrada")
      .reduce((total, item) => total + item.ml, 0);
    const totalSaida = fluidos24h
      .filter(item => item.tipo === "saida")
      .reduce((total, item) => total + item.ml, 0);
    const prescricoes = db.prescricoesInternacao
      .filter(item => Number(item.internacaoId) === id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(prescricao => {
        const medicamento = db.medicacoesDisponiveis.find(
          item => Number(item.id) === Number(prescricao.medicacaoId)
        );
        const administracoes = db.administracoesMedicacao
          .filter(item => Number(item.prescricaoId) === Number(prescricao.id))
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return {
          ...prescricao,
          medicacao: medicamento ? { id: medicamento.id, nome: medicamento.nome } : null,
          administracoes,
          quantidadeAdministrada: administracoes.reduce((total, item) => total + item.quantidade, 0)
        };
      });

    registrarAuditoria(db, req.user.nome, "consultar", "registros_enfermagem", id);
    writeDB(db);
    res.json({
      evolucoes: recentes(db.evolucoesEnfermagem),
      sinaisVitais: recentes(db.sinaisVitaisEnfermagem),
      balancoHidrico: fluidos,
      procedimentos: recentes(db.procedimentosEnfermagem),
      prescricoes,
      totais24h: {
        entradaMl: totalEntrada,
        saidaMl: totalSaida,
        saldoMl: totalEntrada - totalSaida
      }
    });
  }
);

app.post("/enfermagem/evolucoes",
  ...exigir("medico", "enfermagem", "tecnico_enfermagem"),
  (req, res) => {
    const body = req.body || {};
    const internacaoId = Number(body.internacaoId);
    const registro = texto(body.registro);
    if (!Number.isSafeInteger(internacaoId) || internacaoId <= 0) {
      throw new ErroHttp(400, "Selecione uma internação válida.");
    }
    if (!registro || registro.length > 3000) {
      throw new ErroHttp(400, "Informe a evolução (até 3000 caracteres).");
    }

    const db = readDB();
    exigirInternacao(db, internacaoId);
    const evolucao = {
      id: novoId(),
      internacaoId,
      registro,
      profissional: req.user.nome,
      criadoEm: agora(),
      createdAt: agora()
    };
    db.evolucoesEnfermagem.push(evolucao);
    registrarAuditoria(db, req.user.nome, "registrar", "evolucao_enfermagem", evolucao.id);
    writeDB(db);
    res.status(201).json(evolucao);
  }
);

app.post("/internacoes/:id/prescricoes", ...exigir("medico"), (req, res) => {
  const internacaoId = Number(req.params.id);
  const medicacaoId = Number(req.body && req.body.medicacaoId);
  const dose = texto(req.body && req.body.dose);
  const via = texto(req.body && req.body.via);
  const frequencia = texto(req.body && req.body.frequencia);
  const quantidade = lerQuantidade(req.body && req.body.quantidade);
  const vias = ["Oral", "Intravenosa", "Intramuscular", "Subcutânea", "Tópica", "Inalatória", "Sublingual"];

  if (!Number.isSafeInteger(internacaoId) || internacaoId <= 0 ||
      !Number.isSafeInteger(medicacaoId) || medicacaoId <= 0) {
    throw new ErroHttp(400, "Internação e medicação são obrigatórias.");
  }
  if (!dose || dose.length > 60 || !frequencia || frequencia.length > 100 ||
      !vias.includes(via) || quantidade === null || quantidade < 1 || quantidade > 1000) {
    throw new ErroHttp(400, "Confira dose, via, frequência e quantidade prescrita.");
  }

  const db = readDB();
  const internacao = exigirInternacao(db, internacaoId);
  const medicamento = db.medicacoesDisponiveis.find(item => Number(item.id) === medicacaoId);
  if (!medicamento) throw new ErroHttp(404, "Medicação não cadastrada.");
  if ((Number(medicamento.quantidade) || 0) <= 0) {
    throw new ErroHttp(409, `Sem estoque de ${medicamento.nome}.`);
  }
  if (quantidade > (Number(medicamento.quantidade) || 0)) {
    throw new ErroHttp(409, `Estoque insuficiente para prescrever ${quantidade} unidade(s) de ${medicamento.nome}.`);
  }
  const pessoa = db.pessoas.find(item => Number(item.id) === Number(internacao.pessoaId));
  const alergias = [...new Set([
    ...(pessoa && Array.isArray(pessoa.alergias) ? pessoa.alergias : []),
    ...db.pacientes
      .filter(item => Number(item.pessoaId) === Number(internacao.pessoaId))
      .flatMap(item => listarAlergias(db, item))
  ])];
  const alergia = alergias.find(valor =>
    valor.toLocaleLowerCase("pt-BR").includes(medicamento.nome.toLocaleLowerCase("pt-BR")) ||
    medicamento.nome.toLocaleLowerCase("pt-BR").includes(valor.toLocaleLowerCase("pt-BR"))
  );
  if (alergia && req.body.confirmarAlergia !== true) {
    return res.status(409).json({
      erro: `Alergia registrada: ${alergia}. Confirme antes de prescrever ${medicamento.nome}.`,
      alergia: true
    });
  }

  const prescricao = {
    id: novoId(),
    internacaoId,
    pessoaId: internacao.pessoaId,
    medicacaoId,
    dose,
    via,
    frequencia,
    quantidade,
    alergiaConfirmada: Boolean(alergia && req.body.confirmarAlergia === true),
    medico: req.user.nome,
    createdAt: agora(),
    updatedAt: agora()
  };
  db.prescricoesInternacao.push(prescricao);
  registrarAuditoria(db, req.user.nome, "prescrever", "medicacao_internacao", prescricao.id);
  writeDB(db);
  res.status(201).json({
    ...prescricao,
    medicacao: { id: medicamento.id, nome: medicamento.nome },
    administracoes: [],
    quantidadeAdministrada: 0
  });
});

app.post("/prescricoes-internacao/:id/administrar",
  ...exigir("medicacao", "enfermagem", "tecnico_enfermagem"),
  (req, res) => {
    const prescricaoId = Number(req.params.id);
    const quantidade = lerQuantidade(req.body && req.body.quantidade);
    const idempotencia = texto(req.body && req.body.idempotencia);
    if (!Number.isSafeInteger(prescricaoId) || prescricaoId <= 0) {
      throw new ErroHttp(400, "Prescrição inválida.");
    }
    if (quantidade === null || quantidade < 1 || quantidade > 100) {
      throw new ErroHttp(400, "A quantidade administrada deve ser de 1 a 100 unidades.");
    }
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencia)) {
      throw new ErroHttp(400, "Informe a chave de segurança da administração.");
    }

    const db = readDB();
    const anterior = db.administracoesMedicacao.find(item => item.idempotencia === idempotencia);
    if (anterior) {
      if (Number(anterior.prescricaoId) !== prescricaoId || anterior.quantidade !== quantidade) {
        throw new ErroHttp(409, "A chave da administração já foi usada em outra operação.");
      }
      return res.json({ ...anterior, duplicada: true });
    }

    const prescricao = db.prescricoesInternacao.find(item => Number(item.id) === prescricaoId);
    if (!prescricao) throw new ErroHttp(404, "Prescrição não encontrada.");
    exigirInternacao(db, prescricao.internacaoId);
    const administradas = db.administracoesMedicacao
      .filter(item => Number(item.prescricaoId) === prescricaoId)
      .reduce((total, item) => total + Number(item.quantidade || 0), 0);
    if (administradas + quantidade > Number(prescricao.quantidade)) {
      throw new ErroHttp(409, "A quantidade excede o saldo desta prescrição.");
    }

    const medicamento = db.medicacoesDisponiveis.find(
      item => Number(item.id) === Number(prescricao.medicacaoId)
    );
    if (!medicamento) throw new ErroHttp(404, "Medicação prescrita não encontrada no estoque.");
    const saldoAnterior = Number(medicamento.quantidade) || 0;
    if (quantidade > saldoAnterior) {
      throw new ErroHttp(409, `Estoque insuficiente de ${medicamento.nome}.`);
    }

    medicamento.quantidade = saldoAnterior - quantidade;
    registrarMovimento(
      db,
      medicamento,
      "saida",
      quantidade,
      saldoAnterior,
      `Administração conforme prescrição ${prescricaoId}`,
      req.user.nome
    );
    const administracao = {
      id: novoId(),
      prescricaoId,
      internacaoId: prescricao.internacaoId,
      medicacaoId: medicamento.id,
      quantidade,
      dose: prescricao.dose,
      via: prescricao.via,
      administradoPor: req.user.nome,
      idempotencia,
      createdAt: agora()
    };
    db.administracoesMedicacao.push(administracao);
    registrarAuditoria(db, req.user.nome, "administrar", "medicacao_internacao", administracao.id);
    writeDB(db);
    res.status(201).json({
      ...administracao,
      medicacao: medicamento.nome,
      saldoEstoque: medicamento.quantidade
    });
  }
);

app.post("/enfermagem/sinais-vitais",
  ...exigir("medico", "enfermagem", "tecnico_enfermagem"),
  (req, res) => {
    const body = req.body || {};
    const internacaoId = Number(body.internacaoId);
    if (!Number.isSafeInteger(internacaoId) || internacaoId <= 0) {
      throw new ErroHttp(400, "Selecione uma internação válida.");
    }

    const sinais = {
      pressao: texto(body.pressao),
      temperatura: numeroClinico(body.temperatura, "temperatura", 30, 45),
      frequenciaCardiaca: numeroClinico(body.frequenciaCardiaca, "frequência cardíaca", 20, 250, true),
      frequenciaRespiratoria: numeroClinico(body.frequenciaRespiratoria, "frequência respiratória", 4, 80, true),
      saturacao: numeroClinico(body.saturacao, "saturação", 50, 100, true),
      glicemia: numeroClinico(body.glicemia, "glicemia", 20, 1000),
      peso: numeroClinico(body.peso, "peso", 0.5, 400)
    };
    const temSinal = Object.values(sinais).some(valor => valor !== null && valor !== "");
    if (!temSinal) throw new ErroHttp(400, "Informe ao menos um sinal vital.");
    if (sinais.pressao) {
      const partes = /^(\d{2,3})\/(\d{2,3})$/.exec(sinais.pressao);
      if (!partes || Number(partes[1]) < 40 || Number(partes[1]) > 260 ||
          Number(partes[2]) < 20 || Number(partes[2]) > 160) {
        throw new ErroHttp(400, "Informe a pressão no formato 120/80.");
      }
    } else {
      sinais.pressao = "";
    }

    const db = readDB();
    exigirInternacao(db, internacaoId);
    const registro = {
      id: novoId(),
      internacaoId,
      ...sinais,
      profissional: req.user.nome,
      createdAt: agora()
    };
    db.sinaisVitaisEnfermagem.push(registro);
    registrarAuditoria(db, req.user.nome, "registrar", "sinais_vitais_internacao", registro.id);
    writeDB(db);
    res.status(201).json(registro);
  }
);

app.post("/enfermagem/balanco-hidrico",
  ...exigir("medico", "enfermagem", "tecnico_enfermagem"),
  (req, res) => {
    const body = req.body || {};
    const internacaoId = Number(body.internacaoId);
    const tipo = texto(body.tipo);
    const item = texto(body.item);
    const ml = numeroClinico(body.ml, "volume em mililitros", 1, 10000, true);
    const observacao = texto(body.observacao);
    if (!Number.isSafeInteger(internacaoId) || internacaoId <= 0) {
      throw new ErroHttp(400, "Selecione uma internação válida.");
    }
    if (!["entrada", "saida"].includes(tipo)) {
      throw new ErroHttp(400, "Selecione entrada ou saída de líquido.");
    }
    if (!item || item.length > 100 || observacao.length > 500) {
      throw new ErroHttp(400, "Informe o item (até 100 caracteres) e observação válida.");
    }

    const db = readDB();
    exigirInternacao(db, internacaoId);
    const balanco = {
      id: novoId(),
      internacaoId,
      tipo,
      item,
      ml,
      observacao,
      profissional: req.user.nome,
      createdAt: agora()
    };
    db.balancosHidricos.push(balanco);
    registrarAuditoria(db, req.user.nome, "registrar", "balanco_hidrico", balanco.id);
    writeDB(db);
    res.status(201).json(balanco);
  }
);

app.post("/enfermagem/procedimentos",
  ...exigir("medico", "enfermagem", "tecnico_enfermagem"),
  (req, res) => {
    const body = req.body || {};
    const internacaoId = Number(body.internacaoId);
    const procedimento = texto(body.procedimento);
    const observacao = texto(body.observacao);
    if (!Number.isSafeInteger(internacaoId) || internacaoId <= 0) {
      throw new ErroHttp(400, "Selecione uma internação válida.");
    }
    if (!procedimento || procedimento.length > 150 || observacao.length > 1000) {
      throw new ErroHttp(400, "Informe o procedimento (até 150 caracteres) e observação válida.");
    }

    const db = readDB();
    exigirInternacao(db, internacaoId);
    const registro = {
      id: novoId(),
      internacaoId,
      procedimento,
      observacao,
      profissional: req.user.nome,
      createdAt: agora()
    };
    db.procedimentosEnfermagem.push(registro);
    registrarAuditoria(db, req.user.nome, "registrar", "procedimento_enfermagem", registro.id);
    writeDB(db);
    res.status(201).json(registro);
  }
);

// =====================================================
// API - LABORATÓRIO E EXAMES
// =====================================================

const STATUS_EXAMES = ["solicitado", "coletado", "resultado_liberado", "cancelado"];

function formatarSolicitacaoExame(db, solicitacao) {
  const pessoa = db.pessoas.find(item => Number(item.id) === Number(solicitacao.pessoaId));
  const exame = db.examesCatalogo.find(item => Number(item.id) === Number(solicitacao.exameId));
  return {
    ...solicitacao,
    paciente: pessoa ? { id: pessoa.id, nome: pessoa.nome, cpf: pessoa.cpf } : null,
    exame: exame ? { id: exame.id, codigo: exame.codigo, nome: exame.nome } : null
  };
}

app.get("/exames/catalogo",
  ...exigir("medico", "laboratorista", "enfermagem", "tecnico_enfermagem"),
  (req, res) => {
    const catalogo = readDB().examesCatalogo
      .filter(exame => exame.ativo !== false)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    res.json(catalogo);
  }
);

app.post("/exames/catalogo", ...exigir(), (req, res) => {
  const body = req.body || {};
  const codigo = texto(body.codigo).toLocaleUpperCase("pt-BR");
  const nome = texto(body.nome);
  const descricao = texto(body.descricao);
  if (!codigo || codigo.length > 30 || !nome || nome.length > 120 || descricao.length > 300) {
    throw new ErroHttp(400, "Informe código e nome válidos para o exame.");
  }

  const db = readDB();
  const duplicado = db.examesCatalogo.some(exame =>
    mesmoLogin(exame.codigo, codigo) || mesmoLogin(exame.nome, nome)
  );
  if (duplicado) throw new ErroHttp(409, "Já existe um exame com esse código ou nome.");

  const exame = {
    id: proximoId(db.examesCatalogo),
    codigo,
    nome,
    descricao,
    ativo: true,
    createdAt: agora(),
    updatedAt: agora()
  };
  db.examesCatalogo.push(exame);
  registrarAuditoria(db, req.user.nome, "criar", "exame_catalogo", exame.id);
  writeDB(db);
  res.status(201).json(exame);
});

app.patch("/exames/catalogo/:id", ...exigir(), (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Exame inválido.");
  if (typeof body.ativo !== "boolean") {
    throw new ErroHttp(400, "Informe se o exame deve permanecer ativo.");
  }

  const db = readDB();
  const exame = db.examesCatalogo.find(item => Number(item.id) === id);
  if (!exame) throw new ErroHttp(404, "Exame não encontrado.");
  exame.ativo = body.ativo;
  exame.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "alterar_status", "exame_catalogo", id);
  writeDB(db);
  res.json(exame);
});

app.get("/exames/pacientes", ...exigir("medico", "laboratorista"), (req, res) => {
  const busca = texto(req.query.busca);
  if (busca.length < 2) return res.json([]);
  const db = readDB();
  migrarPessoasLegadas(db);
  const nomeBusca = busca.toLocaleLowerCase("pt-BR");
  const cpfBusca = cpfNormalizado(busca);
  const pessoas = db.pessoas
    .filter(pessoa =>
      texto(pessoa.nome).toLocaleLowerCase("pt-BR").includes(nomeBusca) ||
      (cpfBusca.length >= 3 && cpfNormalizado(pessoa.cpf).includes(cpfBusca))
    )
    .slice(0, 50)
    .map(({ id, nome, cpf }) => ({ id, nome, cpf }));
  registrarAuditoria(db, req.user.nome, "consultar_busca", "pacientes_exames");
  writeDB(db);
  res.json(pessoas);
});

app.get("/exames", ...exigir("medico", "laboratorista", "enfermagem", "tecnico_enfermagem"), (req, res) => {
  const status = texto(req.query.status);
  if (status && !STATUS_EXAMES.includes(status)) throw new ErroHttp(400, "Status de exame inválido.");
  const db = readDB();
  const exames = db.solicitacoesExames
    .filter(item =>
      (!status || item.status === status) &&
      (req.user.tipo !== "medico" || mesmoLogin(item.solicitadoPorUsuario, req.user.usuario))
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(item => formatarSolicitacaoExame(db, item));
  registrarAuditoria(db, req.user.nome, "consultar", "solicitacoes_exames");
  writeDB(db);
  res.json(exames);
});

app.post("/exames", ...exigir("medico"), (req, res) => {
  const body = req.body || {};
  const pessoaId = Number(body.pessoaId);
  const exameId = Number(body.exameId);
  const prioridade = texto(body.prioridade || "rotina");
  const indicacao = texto(body.indicacao);
  const associacaoInformada = body.internacaoId !== undefined &&
    body.internacaoId !== null && body.internacaoId !== "";
  const internacaoId = associacaoInformada ? Number(body.internacaoId) : null;
  if (!Number.isSafeInteger(pessoaId) || pessoaId <= 0 ||
      !Number.isSafeInteger(exameId) || exameId <= 0) {
    throw new ErroHttp(400, "Selecione paciente e exame.");
  }
  if (!["rotina", "urgente"].includes(prioridade) || !indicacao || indicacao.length > 1000) {
    throw new ErroHttp(400, "Informe prioridade válida e indicação clínica (até 1000 caracteres).");
  }

  const db = readDB();
  migrarPessoasLegadas(db);
  const pessoa = db.pessoas.find(item => Number(item.id) === pessoaId);
  if (!pessoa) throw new ErroHttp(404, "Paciente não encontrado.");
  const exame = db.examesCatalogo.find(item => Number(item.id) === exameId && item.ativo !== false);
  if (!exame) throw new ErroHttp(404, "Exame não encontrado ou inativo.");
  if (associacaoInformada) {
    if (!Number.isSafeInteger(internacaoId) || internacaoId <= 0) {
      throw new ErroHttp(400, "Internação inválida.");
    }
    const internacao = exigirInternacao(db, internacaoId);
    if (Number(internacao.pessoaId) !== pessoaId) {
      throw new ErroHttp(400, "A internação selecionada não pertence ao paciente.");
    }
  }

  const solicitacao = {
    id: novoId(),
    pessoaId,
    exameId,
    internacaoId,
    prioridade,
    indicacao,
    status: "solicitado",
    solicitadoPor: req.user.nome,
    solicitadoPorUsuario: req.user.usuario,
    createdAt: agora(),
    updatedAt: agora()
  };
  db.solicitacoesExames.push(solicitacao);
  registrarAuditoria(db, req.user.nome, "solicitar", "exame", solicitacao.id);
  writeDB(db);
  res.status(201).json(formatarSolicitacaoExame(db, solicitacao));
});

app.post("/exames/:id/coleta",
  ...exigir("laboratorista", "enfermagem", "tecnico_enfermagem"),
  (req, res) => {
    const id = Number(req.params.id);
    const observacao = texto(req.body && req.body.observacao);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Solicitação inválida.");
    if (observacao.length > 500) throw new ErroHttp(400, "A observação excede o limite permitido.");

    const db = readDB();
    const solicitacao = db.solicitacoesExames.find(item => Number(item.id) === id);
    if (!solicitacao) throw new ErroHttp(404, "Solicitação de exame não encontrada.");
    if (solicitacao.status !== "solicitado") {
      throw new ErroHttp(409, "Somente exames solicitados podem ser coletados.");
    }
    solicitacao.status = "coletado";
    solicitacao.coletadoEm = agora();
    solicitacao.coletadoPor = req.user.nome;
    solicitacao.observacaoColeta = observacao;
    solicitacao.updatedAt = agora();
    registrarAuditoria(db, req.user.nome, "coletar", "exame", id);
    writeDB(db);
    res.json(formatarSolicitacaoExame(db, solicitacao));
  }
);

app.post("/exames/:id/resultado", ...exigir("laboratorista"), (req, res) => {
  const id = Number(req.params.id);
  const resultado = texto(req.body && req.body.resultado);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Solicitação inválida.");
  if (!resultado || resultado.length > 10000) {
    throw new ErroHttp(400, "Informe o resultado textual (até 10000 caracteres).");
  }

  const db = readDB();
  const solicitacao = db.solicitacoesExames.find(item => Number(item.id) === id);
  if (!solicitacao) throw new ErroHttp(404, "Solicitação de exame não encontrada.");
  if (solicitacao.status !== "coletado") {
    throw new ErroHttp(409, "Registre a coleta antes de liberar o resultado.");
  }
  solicitacao.status = "resultado_liberado";
  solicitacao.resultado = resultado;
  solicitacao.resultadoPor = req.user.nome;
  solicitacao.resultadoEm = agora();
  solicitacao.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "liberar_resultado", "exame", id);
  writeDB(db);
  res.json(formatarSolicitacaoExame(db, solicitacao));
});

app.post("/exames/:id/cancelar", ...exigir("medico"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Solicitação inválida.");
  const db = readDB();
  const solicitacao = db.solicitacoesExames.find(item => Number(item.id) === id);
  if (!solicitacao) throw new ErroHttp(404, "Solicitação de exame não encontrada.");
  if ((req.user.tipo !== "admin" &&
      !mesmoLogin(solicitacao.solicitadoPorUsuario, req.user.usuario)) ||
      solicitacao.status !== "solicitado") {
    throw new ErroHttp(409, "Só é possível cancelar uma solicitação pendente própria; a administração pode cancelar qualquer solicitação pendente.");
  }
  solicitacao.status = "cancelado";
  solicitacao.canceladoPor = req.user.nome;
  solicitacao.canceladoEm = agora();
  solicitacao.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "cancelar", "exame", id);
  writeDB(db);
  res.json(formatarSolicitacaoExame(db, solicitacao));
});

// =====================================================
// API - CENTRO CIRÚRGICO
// =====================================================

function dataCirurgiaValida(valor) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(valor)) {
    return false;
  }
  const data = new Date(valor);
  return Number.isFinite(data.getTime()) && data.toISOString() === valor;
}

function formatarCirurgia(db, cirurgia) {
  const pessoa = db.pessoas.find(item => Number(item.id) === Number(cirurgia.pessoaId));
  const procedimento = db.procedimentosCirurgicos.find(
    item => Number(item.id) === Number(cirurgia.procedimentoId)
  );
  const sala = db.salasCirurgicas.find(item => Number(item.id) === Number(cirurgia.salaId));
  const cirurgiao = db.usuarios.find(item => mesmoLogin(item.usuario, cirurgia.cirurgiao));
  return {
    ...cirurgia,
    paciente: pessoa ? { id: pessoa.id, nome: pessoa.nome, cpf: pessoa.cpf } : null,
    procedimento: procedimento ? { id: procedimento.id, codigo: procedimento.codigo, nome: procedimento.nome } : null,
    sala: sala ? { id: sala.id, nome: sala.nome } : null,
    cirurgiaoNome: cirurgiao ? nomeDe(cirurgiao) : cirurgia.cirurgiao
  };
}

function equipeCirurgica(db, cirurgiao, equipe) {
  if (!Array.isArray(equipe) || equipe.length > 12) {
    throw new ErroHttp(400, "A equipe cirúrgica deve conter até 12 profissionais.");
  }
  const profissionais = [];
  for (const loginValor of equipe) {
    const login = texto(loginValor);
    if (!login || mesmoLogin(login, cirurgiao)) continue;
    const usuario = db.usuarios.find(item =>
      item.tipo === "medico" && mesmoLogin(item.usuario, login)
    );
    if (!usuario) throw new ErroHttp(400, "Todos os membros médicos da equipe devem ter cadastro ativo.");
    if (!profissionais.some(item => mesmoLogin(item.usuario, usuario.usuario))) {
      profissionais.push({ usuario: usuario.usuario, nome: nomeDe(usuario) });
    }
  }
  return profissionais;
}

function conflitoCirurgia(db, inicio, fim, salaId, pessoaId, cirurgiao, equipe = [], ignorarId = null) {
  const profissionais = [cirurgiao, ...equipe.map(item => item.usuario)];
  return db.cirurgias.some(item => {
    if (item.status !== "agendada" || Number(item.id) === Number(ignorarId)) return false;
    const inicioExistente = Date.parse(item.inicio);
    const fimExistente = inicioExistente + Number(item.duracaoMinutos) * 60000;
    const sobreposicao = inicio < fimExistente && inicioExistente < fim;
    const equipeExistente = [item.cirurgiao, ...(item.equipe || []).map(profissional => profissional.usuario)];
    const profissionalConflitante = profissionais.some(profissional =>
      equipeExistente.some(existente => mesmoLogin(profissional, existente))
    );
    return sobreposicao &&
      (Number(item.salaId) === Number(salaId) ||
        Number(item.pessoaId) === Number(pessoaId) ||
        profissionalConflitante);
  });
}

app.get("/cirurgias/salas", ...exigir("medico", "centro_cirurgico"), (req, res) => {
  const salas = readDB().salasCirurgicas
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  res.json(salas);
});

app.post("/cirurgias/salas", ...exigir(), (req, res) => {
  const nome = texto(req.body && req.body.nome);
  const local = texto(req.body && req.body.local);
  if (!nome || nome.length > 80 || local.length > 120) {
    throw new ErroHttp(400, "Informe um nome válido para a sala e local (opcional).");
  }
  const db = readDB();
  if (db.salasCirurgicas.some(item => mesmoLogin(item.nome, nome))) {
    throw new ErroHttp(409, "Já existe uma sala cirúrgica com esse nome.");
  }
  const sala = {
    id: proximoId(db.salasCirurgicas),
    nome,
    local,
    status: "ativa",
    createdAt: agora(),
    updatedAt: agora()
  };
  db.salasCirurgicas.push(sala);
  registrarAuditoria(db, req.user.nome, "criar", "sala_cirurgica", sala.id);
  writeDB(db);
  res.status(201).json(sala);
});

app.patch("/cirurgias/salas/:id", ...exigir(), (req, res) => {
  const id = Number(req.params.id);
  const status = texto(req.body && req.body.status);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Sala inválida.");
  if (!["ativa", "manutencao"].includes(status)) throw new ErroHttp(400, "Status de sala inválido.");
  const db = readDB();
  const sala = db.salasCirurgicas.find(item => Number(item.id) === id);
  if (!sala) throw new ErroHttp(404, "Sala cirúrgica não encontrada.");
  if (status === "manutencao" && db.cirurgias.some(item =>
    Number(item.salaId) === id && item.status === "agendada" &&
    Date.parse(item.inicio) + Number(item.duracaoMinutos) * 60000 > Date.now()
  )) {
    throw new ErroHttp(409, "A sala possui cirurgias agendadas; reagende-as antes da manutenção.");
  }
  sala.status = status;
  sala.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "alterar_status", "sala_cirurgica", id);
  writeDB(db);
  res.json(sala);
});

app.get("/cirurgias/catalogo", ...exigir("medico", "centro_cirurgico"), (req, res) => {
  const lista = readDB().procedimentosCirurgicos
    .filter(item => item.ativo !== false)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  res.json(lista);
});

app.post("/cirurgias/catalogo", ...exigir(), (req, res) => {
  const codigo = texto(req.body && req.body.codigo).toLocaleUpperCase("pt-BR");
  const nome = texto(req.body && req.body.nome);
  const descricao = texto(req.body && req.body.descricao);
  if (!codigo || codigo.length > 30 || !nome || nome.length > 150 || descricao.length > 500) {
    throw new ErroHttp(400, "Informe código e nome válidos para o procedimento.");
  }
  const db = readDB();
  if (db.procedimentosCirurgicos.some(item =>
    mesmoLogin(item.codigo, codigo) || mesmoLogin(item.nome, nome)
  )) {
    throw new ErroHttp(409, "Já existe um procedimento com esse código ou nome.");
  }
  const procedimento = {
    id: proximoId(db.procedimentosCirurgicos),
    codigo,
    nome,
    descricao,
    ativo: true,
    createdAt: agora(),
    updatedAt: agora()
  };
  db.procedimentosCirurgicos.push(procedimento);
  registrarAuditoria(db, req.user.nome, "criar", "procedimento_cirurgico", procedimento.id);
  writeDB(db);
  res.status(201).json(procedimento);
});

app.patch("/cirurgias/catalogo/:id", ...exigir(), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Procedimento inválido.");
  if (!req.body || typeof req.body.ativo !== "boolean") {
    throw new ErroHttp(400, "Informe se o procedimento deve permanecer ativo.");
  }
  const db = readDB();
  const procedimento = db.procedimentosCirurgicos.find(item => Number(item.id) === id);
  if (!procedimento) throw new ErroHttp(404, "Procedimento não encontrado.");
  procedimento.ativo = req.body.ativo;
  procedimento.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "alterar_status", "procedimento_cirurgico", id);
  writeDB(db);
  res.json(procedimento);
});

app.get("/cirurgias/pacientes", ...exigir("medico", "centro_cirurgico"), (req, res) => {
  const busca = texto(req.query.busca);
  if (busca.length < 2) return res.json([]);
  const db = readDB();
  migrarPessoasLegadas(db);
  const nomeBusca = busca.toLocaleLowerCase("pt-BR");
  const cpfBusca = cpfNormalizado(busca);
  const pessoas = db.pessoas
    .filter(pessoa =>
      texto(pessoa.nome).toLocaleLowerCase("pt-BR").includes(nomeBusca) ||
      (cpfBusca.length >= 3 && cpfNormalizado(pessoa.cpf).includes(cpfBusca))
    )
    .slice(0, 50)
    .map(({ id, nome, cpf }) => ({ id, nome, cpf }));
  registrarAuditoria(db, req.user.nome, "consultar_busca", "pacientes_cirurgia");
  writeDB(db);
  res.json(pessoas);
});

app.get("/cirurgias/medicos", ...exigir("medico", "centro_cirurgico"), (req, res) => {
  const medicos = readDB().usuarios
    .filter(item => item.tipo === "medico")
    .map(item => ({ usuario: item.usuario, nome: nomeDe(item) }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  res.json(medicos);
});

app.get("/cirurgias", ...exigir("medico", "centro_cirurgico"), (req, res) => {
  const status = texto(req.query.status);
  if (status && !["agendada", "realizada", "cancelada"].includes(status)) {
    throw new ErroHttp(400, "Filtro de status inválido.");
  }
  const db = readDB();
  const lista = db.cirurgias
    .filter(item =>
      (!status || item.status === status) &&
      (req.user.tipo !== "medico" ||
        mesmoLogin(item.cirurgiao, req.user.usuario) ||
        (item.equipe || []).some(profissional => mesmoLogin(profissional.usuario, req.user.usuario)))
    )
    .sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio))
    .map(item => formatarCirurgia(db, item));
  registrarAuditoria(db, req.user.nome, "consultar", "cirurgias");
  writeDB(db);
  res.json(lista);
});

app.post("/cirurgias", ...exigir("medico", "centro_cirurgico"), (req, res) => {
  const body = req.body || {};
  const pessoaId = Number(body.pessoaId);
  const procedimentoId = Number(body.procedimentoId);
  const salaId = Number(body.salaId);
  const cirurgiaoLogin = texto(body.cirurgiao);
  const inicio = texto(body.inicio);
  const duracaoMinutos = Number(body.duracaoMinutos);
  const observacoes = texto(body.observacoes);
  const internacaoId = body.internacaoId === undefined || body.internacaoId === null ||
    body.internacaoId === "" ? null : Number(body.internacaoId);
  if (!Number.isSafeInteger(pessoaId) || pessoaId <= 0 ||
      !Number.isSafeInteger(procedimentoId) || procedimentoId <= 0 ||
      !Number.isSafeInteger(salaId) || salaId <= 0) {
    throw new ErroHttp(400, "Selecione paciente, procedimento e sala.");
  }
  if (!dataCirurgiaValida(inicio) || Date.parse(inicio) <= Date.now()) {
    throw new ErroHttp(400, "Informe uma data futura válida para a cirurgia.");
  }
  if (!Number.isSafeInteger(duracaoMinutos) || duracaoMinutos < 15 || duracaoMinutos > 1440) {
    throw new ErroHttp(400, "A duração deve ser de 15 a 1440 minutos.");
  }
  if (observacoes.length > 2000) throw new ErroHttp(400, "As observações excedem o limite permitido.");

  const db = readDB();
  migrarPessoasLegadas(db);
  const pessoa = db.pessoas.find(item => Number(item.id) === pessoaId);
  if (!pessoa) throw new ErroHttp(404, "Paciente não encontrado.");
  const procedimento = db.procedimentosCirurgicos.find(item =>
    Number(item.id) === procedimentoId && item.ativo !== false
  );
  if (!procedimento) throw new ErroHttp(404, "Procedimento não encontrado ou inativo.");
  const sala = db.salasCirurgicas.find(item => Number(item.id) === salaId);
  if (!sala) throw new ErroHttp(404, "Sala cirúrgica não encontrada.");
  if (sala.status !== "ativa") throw new ErroHttp(409, "A sala cirúrgica não está ativa.");
  const cirurgiao = db.usuarios.find(item =>
    item.tipo === "medico" && mesmoLogin(item.usuario, cirurgiaoLogin)
  );
  if (!cirurgiao) throw new ErroHttp(400, "Selecione um médico cirurgião cadastrado.");
  if (req.user.tipo === "medico" && !mesmoLogin(cirurgiao.usuario, req.user.usuario)) {
    throw new ErroHttp(403, "Médicos só podem agendar cirurgias para si mesmos.");
  }
  const equipe = equipeCirurgica(db, cirurgiao.usuario, body.equipe || []);
  if (req.user.tipo === "medico" &&
      !equipe.some(item => mesmoLogin(item.usuario, req.user.usuario)) &&
      !mesmoLogin(cirurgiao.usuario, req.user.usuario)) {
    throw new ErroHttp(403, "Médicos só podem incluir a si mesmos na equipe.");
  }
  if (internacaoId !== null) {
    if (!Number.isSafeInteger(internacaoId) || internacaoId <= 0) {
      throw new ErroHttp(400, "Internação inválida.");
    }
    const internacao = exigirInternacao(db, internacaoId);
    if (Number(internacao.pessoaId) !== pessoaId) {
      throw new ErroHttp(400, "A internação selecionada não pertence ao paciente.");
    }
  }

  const inicioMs = Date.parse(inicio);
  const fimMs = inicioMs + duracaoMinutos * 60000;
  if (conflitoCirurgia(db, inicioMs, fimMs, salaId, pessoaId, cirurgiao.usuario, equipe)) {
    throw new ErroHttp(409, "A sala, o paciente ou um membro da equipe já possui outra cirurgia nesse horário.");
  }

  const cirurgia = {
    id: novoId(),
    pessoaId,
    internacaoId,
    procedimentoId,
    salaId,
    cirurgiao: cirurgiao.usuario,
    equipe,
    inicio,
    duracaoMinutos,
    observacoes,
    status: "agendada",
    agendadoPor: req.user.nome,
    createdAt: agora(),
    updatedAt: agora()
  };
  db.cirurgias.push(cirurgia);
  registrarAuditoria(db, req.user.nome, "agendar", "cirurgia", cirurgia.id);
  writeDB(db);
  res.status(201).json(formatarCirurgia(db, cirurgia));
});

app.post("/cirurgias/:id/realizar", ...exigir("medico", "centro_cirurgico"), (req, res) => {
  const id = Number(req.params.id);
  const resumo = texto(req.body && req.body.resumo);
  const intercorrencias = texto(req.body && req.body.intercorrencias);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Cirurgia inválida.");
  if (!resumo || resumo.length > 4000 || intercorrencias.length > 2000) {
    throw new ErroHttp(400, "Informe o resumo cirúrgico (até 4000 caracteres) e intercorrências válidas.");
  }
  const db = readDB();
  const cirurgia = db.cirurgias.find(item => Number(item.id) === id);
  if (!cirurgia) throw new ErroHttp(404, "Cirurgia não encontrada.");
  if (cirurgia.status !== "agendada") throw new ErroHttp(409, "Somente cirurgias agendadas podem ser registradas como realizadas.");
  if (req.user.tipo === "medico" && !mesmoLogin(cirurgia.cirurgiao, req.user.usuario)) {
    throw new ErroHttp(403, "Somente o cirurgião responsável pode registrar a realização.");
  }
  cirurgia.status = "realizada";
  cirurgia.resumo = resumo;
  cirurgia.intercorrencias = intercorrencias;
  cirurgia.realizadaPor = req.user.nome;
  cirurgia.realizadaEm = agora();
  cirurgia.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "realizar", "cirurgia", id);
  writeDB(db);
  res.json(formatarCirurgia(db, cirurgia));
});

app.post("/cirurgias/:id/cancelar", ...exigir("medico", "centro_cirurgico"), (req, res) => {
  const id = Number(req.params.id);
  const motivo = texto(req.body && req.body.motivo);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "Cirurgia inválida.");
  if (motivo.length > 500) throw new ErroHttp(400, "O motivo do cancelamento excede o limite permitido.");
  const db = readDB();
  const cirurgia = db.cirurgias.find(item => Number(item.id) === id);
  if (!cirurgia) throw new ErroHttp(404, "Cirurgia não encontrada.");
  if (cirurgia.status !== "agendada") throw new ErroHttp(409, "Somente cirurgias agendadas podem ser canceladas.");
  if (req.user.tipo === "medico" && !mesmoLogin(cirurgia.cirurgiao, req.user.usuario)) {
    throw new ErroHttp(403, "Somente o cirurgião responsável pode cancelar esta cirurgia.");
  }
  cirurgia.status = "cancelada";
  cirurgia.motivoCancelamento = motivo;
  cirurgia.canceladaPor = req.user.nome;
  cirurgia.canceladaEm = agora();
  cirurgia.updatedAt = agora();
  registrarAuditoria(db, req.user.nome, "cancelar", "cirurgia", id);
  writeDB(db);
  res.json(formatarCirurgia(db, cirurgia));
});

app.post("/atendimento", ...exigir("atendimento"), (req, res) => {
  const b = req.body || {};

  const nome = texto(b.nome);
  const cpf = texto(b.cpf);
  const nomeMae = texto(b.nome_mae);
  const endereco = texto(b.endereco);
  const telefone = texto(b.telefone);
  const email = texto(b.email);
  const contatoEmergencia = texto(b.contato_emergencia);
  const historicoMedico = texto(b.historicoMedico);
  const doencasPreexistentes = texto(b.doencasPreexistentes);
  const alergias = texto(b.alergias);

  if (!nome) throw new ErroHttp(400, "Informe o nome do paciente.");

  if (!/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(cpf)) {
    throw new ErroHttp(400, "Informe o CPF no formato 000.000.000-00.");
  }

  if (!nomeMae || !endereco || !telefone || !contatoEmergencia) {
    throw new ErroHttp(400, "Preencha nome da mãe, endereço, telefone e contato de emergência.");
  }

  if (historicoMedico.length > 2000 || doencasPreexistentes.length > 1000 || alergias.length > 1000) {
    throw new ErroHttp(400, "As informações médicas excedem o limite permitido.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ErroHttp(400, "Informe um email válido.");
  }

  const estadosCivis = ["Casado(a)", "Separado(a)", "Solteiro(a)"];
  const sexos = ["Masculino", "Feminino"];
  const tipos = ["Convenio", "Particular"];

  const db = readDB();

  if (db.pacientes.some(p =>
    cpfNormalizado(p.cpf) === cpfNormalizado(cpf) && p.status !== "alta"
  )) {
    throw new ErroHttp(409, "Já existe um paciente com esse CPF em atendimento.");
  }

  const atendimentosAnteriores = db.pacientes
    .filter(paciente => cpfNormalizado(paciente.cpf) === cpfNormalizado(cpf))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const registroAnterior = atendimentosAnteriores[0];
  let pessoa = db.pessoas.find(item => cpfNormalizado(item.cpf) === cpfNormalizado(cpf));
  const alergiasInformadas = alergias.split(/[,;]+/).map(item => item.trim()).filter(Boolean);

  if (!pessoa) {
    pessoa = {
      id: proximoId(db.pessoas),
      nome: nome,
      cpf,
      nome_mae: nomeMae,
      estado_civil: estadosCivis.includes(b.estado_civil) ? b.estado_civil : registroAnterior && registroAnterior.estado_civil || "",
      sexo: sexos.includes(b.sexo) ? b.sexo : registroAnterior && registroAnterior.sexo || "",
      tipo: tipos.includes(b.tipo) ? b.tipo : registroAnterior && registroAnterior.tipo || "Geral",
      endereco,
      telefone,
      email,
      contato_emergencia: contatoEmergencia,
      historicoMedico: historicoMedico || registroAnterior && registroAnterior.historicoMedico || "",
      doencasPreexistentes: doencasPreexistentes || registroAnterior && registroAnterior.doencasPreexistentes || "",
      alergias: [...new Set([
        ...(registroAnterior && Array.isArray(registroAnterior.alergias) ? registroAnterior.alergias : []),
        ...alergiasInformadas
      ])],
      createdAt: agora(),
      updatedAt: agora()
    };
    db.pessoas.push(pessoa);
  } else {
    pessoa.nome = nome;
    pessoa.nome_mae = nomeMae || pessoa.nome_mae;
    pessoa.estado_civil = estadosCivis.includes(b.estado_civil) ? b.estado_civil : pessoa.estado_civil;
    pessoa.sexo = sexos.includes(b.sexo) ? b.sexo : pessoa.sexo;
    pessoa.tipo = tipos.includes(b.tipo) ? b.tipo : pessoa.tipo;
    pessoa.endereco = endereco || pessoa.endereco;
    pessoa.telefone = telefone || pessoa.telefone;
    pessoa.email = email || pessoa.email;
    pessoa.contato_emergencia = contatoEmergencia || pessoa.contato_emergencia;
    pessoa.historicoMedico = historicoMedico || pessoa.historicoMedico;
    pessoa.doencasPreexistentes = doencasPreexistentes || pessoa.doencasPreexistentes;
    pessoa.alergias = [...new Set([...(pessoa.alergias || []), ...alergiasInformadas])];
    pessoa.updatedAt = agora();
  }

  atendimentosAnteriores.forEach(atendimento => {
    atendimento.pessoaId = pessoa.id;
  });

  const id = novoId();

  const paciente = {
    id,
    pessoaId: pessoa.id,
    nome: pessoa.nome,
    cpf: pessoa.cpf,
    nome_mae: pessoa.nome_mae,
    estado_civil: pessoa.estado_civil,
    sexo: pessoa.sexo,
    tipo: pessoa.tipo,
    endereco: pessoa.endereco,
    telefone: pessoa.telefone,
    email: pessoa.email,
    contato_emergencia: pessoa.contato_emergencia,
    historicoMedico: pessoa.historicoMedico,
    doencasPreexistentes: pessoa.doencasPreexistentes,
    alergias: [...pessoa.alergias],
    foto: typeof b.foto === "string" && b.foto ? salvarFoto(b.foto, id) : null,
    status: "aguardando_triagem",
    cadastradoPor: req.user.nome,
    createdAt: agora()
  };

  db.pacientes.push(paciente);
  registrarAuditoria(db, req.user.nome, "criar", "paciente", paciente.id);
  writeDB(db);

  res.status(201).json(paciente);
});

// =====================================================
// API - TRIAGEM
// =====================================================

function pacientesComTriagem(db, status) {
  return db.pacientes
    .filter(p => p.status === status)
    .map(p => ({
      ...p,
      triagem: ultimo(db.triagens, t => Number(t.pacienteId) === Number(p.id)) || null,
      alergias: listarAlergias(db, p)
    }));
}

app.get("/pacientes/triagem", ...exigir("triagem"), (req, res) => {
  res.json(pacientesComTriagem(readDB(), "aguardando_triagem"));
});

app.post("/triagem", ...exigir("triagem"), (req, res) => {
  const db = readDB();
  const body = req.body || {};

  const paciente = exigirPaciente(
    db, body.pacienteId, body.nome,
    "aguardando_triagem",
    "Este paciente não está aguardando triagem."
  );

  const sintoma = texto(body.sintoma);
  const temp = Number(body.temperatura);

  if (!sintoma) throw new ErroHttp(400, "Informe os sintomas.");

  if (!Number.isFinite(temp) || temp < 30 || temp > 45) {
    throw new ErroHttp(400, "Informe uma temperatura válida (entre 30 e 45 °C).");
  }

  const sinais = {};
  const limitesSinais = {
    fc: [20, 250],
    fr: [4, 80],
    spo2: [50, 100],
    dor: [0, 10],
    peso: [0.5, 400]
  };

  for (const [campo, [minimo, maximo]] of Object.entries(limitesSinais)) {
    const valor = body[campo];
    if (valor === undefined || valor === null || valor === "") continue;
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < minimo || numero > maximo) {
      throw new ErroHttp(400, `Informe um valor válido para ${campo.toUpperCase()}.`);
    }
    sinais[campo] = numero;
  }

  const pressao = texto(body.pressao);
  if (pressao) {
    const partesPressao = /^(\d{2,3})\/(\d{2,3})$/.exec(pressao);
    if (!partesPressao || Number(partesPressao[1]) < 40 || Number(partesPressao[1]) > 260 ||
      Number(partesPressao[2]) < 20 || Number(partesPressao[2]) > 160) {
      throw new ErroHttp(400, "Informe a pressão no formato 120/80.");
    }
    sinais.pressao = pressao;
  }

  // Risco: a temperatura pode elevar o risco, mas nunca rebaixa
  // um risco "vermelho" escolhido manualmente.
  let risco = RISCOS.includes(body.risco) ? body.risco : null;

  if (temp >= 39) {
    risco = "vermelho";
  } else if (temp >= 38 && risco !== "vermelho") {
    risco = "amarelo";
  } else if (!risco) {
    risco = "verde";
  }

  const motivosRisco = temp >= 39
    ? ["Temperatura igual ou superior a 39 °C."]
    : temp >= 38
      ? ["Temperatura igual ou superior a 38 °C."]
      : [];

  const triagem = {
    id: novoId(),
    pacienteId: paciente.id,
    nome: paciente.nome,
    sintoma,
    temperatura: temp,
    sinais,
    alergia: texto(body.alergia),
    observacao: texto(body.observacao),
    risco,
    motivosRisco,
    funcionario: req.user.nome,
    createdAt: agora()
  };

  db.triagens.push(triagem);

  paciente.status = "aguardando_medico";
  paciente.risco = risco;

  registrarAuditoria(db, req.user.nome, "registrar", "triagem", triagem.id);
  writeDB(db);
  res.json(triagem);
});

app.get("/triagens", ...exigir("triagem", "medico"), (req, res) => {
  res.json(readDB().triagens);
});

// =====================================================
// API - CONSULTA MÉDICA
// =====================================================

app.get("/pacientes/medico", ...exigir("medico"), (req, res) => {
  res.json(pacientesComTriagem(readDB(), "aguardando_medico"));
});

app.post("/consulta", ...exigir("medico"), (req, res) => {
  const db = readDB();
  const body = req.body || {};

  const paciente = exigirPaciente(
    db, body.pacienteId, body.paciente,
    "aguardando_medico",
    "Este paciente não está aguardando consulta."
  );

  const diagnostico = texto(body.diagnostico);
  if (!diagnostico) throw new ErroHttp(400, "Informe o diagnóstico ou a anamnese.");

  let medicacao = texto(body.medicacao);
  let prescricao = null;
  let alergiaConfirmada = false;

  if (medicacao) {
    const item = db.medicacoesDisponiveis.find(m => mesmoLogin(m.nome, medicacao));
    if (!item) throw new ErroHttp(400, "A medicação prescrita não está cadastrada.");
    if ((Number(item.quantidade) || 0) <= 0) {
      throw new ErroHttp(409, `Sem estoque de ${item.nome}.`);
    }
    medicacao = item.nome;

    const alergia = listarAlergias(db, paciente).find(valor =>
      valor.toLocaleLowerCase("pt-BR").includes(medicacao.toLocaleLowerCase("pt-BR")) ||
      medicacao.toLocaleLowerCase("pt-BR").includes(valor.toLocaleLowerCase("pt-BR"))
    );
    if (alergia && body.confirmarAlergia !== true) {
      return res.status(409).json({
        erro: `Alergia registrada: ${alergia}. Confirme antes de prescrever ${medicacao}.`,
        alergia: true
      });
    }

    const quantidade = lerQuantidade(body.quantidade === undefined ? 1 : body.quantidade);
    if (quantidade === null || quantidade < 1 || quantidade > 100) {
      throw new ErroHttp(400, "A quantidade prescrita deve ser um inteiro entre 1 e 100.");
    }
    if (quantidade > (Number(item.quantidade) || 0)) {
      throw new ErroHttp(409, `Estoque insuficiente para prescrever ${quantidade} unidade(s) de ${medicacao}.`);
    }

    const vias = ["", "Oral", "Intravenosa", "Intramuscular", "Subcutânea", "Tópica", "Inalatória", "Sublingual"];
    const dose = texto(body.dose);
    const via = texto(body.via);
    const frequencia = texto(body.frequencia);
    if (dose.length > 60 || frequencia.length > 60 || !vias.includes(via)) {
      throw new ErroHttp(400, "Confira dose, via e frequência da prescrição.");
    }

    alergiaConfirmada = Boolean(alergia && body.confirmarAlergia === true);
    prescricao = {
      medicacao,
      dose,
      via,
      frequencia,
      quantidade,
      alergiaConfirmada
    };
  }

  const prescricaoTexto = prescricao
    ? [medicacao, prescricao.dose, prescricao.via, prescricao.frequencia]
      .filter(Boolean)
      .join(" · ")
    : "";
  const consulta = {
    id: novoId(),
    pacienteId: paciente.id,
    paciente: paciente.nome,
    diagnostico,
    medicacao,
    dose: prescricao ? prescricao.dose : "",
    via: prescricao ? prescricao.via : "",
    frequencia: prescricao ? prescricao.frequencia : "",
    quantidade: prescricao ? prescricao.quantidade : 0,
    prescricao,
    prescricaoTexto,
    obs: texto(body.obs),
    medico: req.user.nome,
    createdAt: agora()
  };

  db.consultas.push(consulta);
  paciente.status = medicacao ? "aguardando_medicacao" : "aguardando_alta";
  registrarAuditoria(db, req.user.nome, "registrar", "consulta", consulta.id);

  writeDB(db);
  res.json(consulta);
});

// =====================================================
// API - MEDICAÇÕES CADASTRADAS (CRUD)
// =====================================================

// Qualquer usuário logado pode consultar (o médico usa para prescrever)
app.get("/lista-medicacoes", autenticar, (req, res) => {
  // Registros antigos sem "quantidade" aparecem com 0
  res.json(
    readDB().medicacoesDisponiveis.map(m => ({ ...m, quantidade: Number(m.quantidade) || 0 }))
  );
});

app.post("/lista-medicacoes", ...exigir("medicacao"), (req, res) => {
  const { nome, quantidade } = req.body || {};
  const nomeNormalizado = texto(nome);

  if (!nomeNormalizado) throw new ErroHttp(400, "Informe o nome da medicação.");

  const qtd = quantidade === undefined || quantidade === "" ? 0 : lerQuantidade(quantidade);

  if (qtd === null) {
    throw new ErroHttp(400, "A quantidade deve ser um número inteiro maior ou igual a zero.");
  }

  const db = readDB();

  if (db.medicacoesDisponiveis.some(m => mesmoLogin(m.nome, nomeNormalizado))) {
    throw new ErroHttp(409, "Essa medicação já está cadastrada.");
  }

  const med = { id: proximoId(db.medicacoesDisponiveis), nome: nomeNormalizado, quantidade: qtd };

  db.medicacoesDisponiveis.push(med);

  if (qtd > 0) {
    registrarMovimento(db, med, "entrada", qtd, 0, "Cadastro inicial", req.user.nome);
  }

  registrarAuditoria(db, req.user.nome, "criar", "medicacao", med.id);
  writeDB(db);
  res.status(201).json({ sucesso: true, medicacao: med });
});

app.put("/lista-medicacoes/:id", ...exigir("medicacao"), (req, res) => {
  const id = Number(req.params.id);
  const { nome, quantidade } = req.body || {};
  const nomeNormalizado = texto(nome);

  if (!Number.isSafeInteger(id) || id <= 0 || !nomeNormalizado) {
    throw new ErroHttp(400, "Informe um ID e um nome válidos.");
  }

  let qtd = null;

  if (quantidade !== undefined && quantidade !== "") {
    qtd = lerQuantidade(quantidade);
    if (qtd === null) {
      throw new ErroHttp(400, "A quantidade deve ser um número inteiro maior ou igual a zero.");
    }
  }

  const db = readDB();
  const indice = db.medicacoesDisponiveis.findIndex(m => Number(m.id) === id);

  if (indice === -1) throw new ErroHttp(404, "Medicação não encontrada.");

  const duplicada = db.medicacoesDisponiveis.some(
    (m, i) => i !== indice && mesmoLogin(m.nome, nomeNormalizado)
  );

  if (duplicada) throw new ErroHttp(409, "Já existe uma medicação com esse nome.");

  const item = db.medicacoesDisponiveis[indice];
  const saldoAnterior = Number(item.quantidade) || 0;

  item.nome = nomeNormalizado;
  item.quantidade = qtd !== null ? qtd : saldoAnterior;

  if (item.quantidade !== saldoAnterior) {
    registrarMovimento(
      db, item, "ajuste", Math.abs(item.quantidade - saldoAnterior), saldoAnterior,
      "Ajuste manual no painel de medicações", req.user.nome
    );
  }

  registrarAuditoria(db, req.user.nome, "atualizar", "medicacao", item.id);
  writeDB(db);
  res.json({ sucesso: true, medicacao: item });
});

app.delete("/lista-medicacoes/:id", ...exigir("medicacao"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, "ID inválido.");

  const db = readDB();
  const indice = db.medicacoesDisponiveis.findIndex(m => Number(m.id) === id);

  if (indice === -1) throw new ErroHttp(404, "Medicação não encontrada.");

  db.medicacoesDisponiveis.splice(indice, 1);
  registrarAuditoria(db, req.user.nome, "excluir", "medicacao", id);
  writeDB(db);

  res.json({ sucesso: true, mensagem: "Medicação excluída com sucesso." });
});

// =====================================================
// API - ALMOXARIFADO (entrada e saída de estoque)
// =====================================================

app.post("/almoxarifado/movimentar", ...exigir("medicacao", "almoxarifado"), (req, res) => {
  const { medicacaoId, tipo, quantidade, observacao } = req.body || {};

  if (!["entrada", "saida"].includes(tipo)) {
    throw new ErroHttp(400, "Escolha entrada ou saída.");
  }

  const qtd = lerQuantidade(quantidade);
  if (qtd === null || qtd < 1 || qtd > 1000000) {
    throw new ErroHttp(400, "A quantidade deve ser um número inteiro maior que zero.");
  }

  const db = readDB();
  const item = db.medicacoesDisponiveis.find(m => Number(m.id) === Number(medicacaoId));

  if (!item) throw new ErroHttp(404, "Medicação não encontrada.");

  const saldoAnterior = Number(item.quantidade) || 0;

  if (tipo === "saida" && qtd > saldoAnterior) {
    throw new ErroHttp(
      409,
      `Saldo insuficiente: há ${saldoAnterior} unidade(s) de ${item.nome} em estoque.`
    );
  }

  item.quantidade = tipo === "entrada" ? saldoAnterior + qtd : saldoAnterior - qtd;

  registrarMovimento(
    db, item, tipo, qtd, saldoAnterior,
    texto(observacao).slice(0, 200), req.user.nome
  );
  registrarAuditoria(db, req.user.nome, tipo, "estoque", item.id);

  writeDB(db);

  res.status(201).json({
    sucesso: true,
    medicacao: item,
    movimento: db.movimentacoes[db.movimentacoes.length - 1]
  });
});

app.get("/almoxarifado/movimentacoes", ...exigir("medicacao", "almoxarifado"), (req, res) => {
  const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 50, 1), 500);
  const filtro = Number(req.query.medicacaoId);

  const lista = readDB().movimentacoes
    .filter(m => !Number.isFinite(filtro) || !filtro || Number(m.medicacaoId) === filtro)
    .slice(-limite)
    .reverse();

  res.json(lista);
});

// =====================================================
// API - SETOR DE MEDICAÇÃO
// =====================================================

app.get("/pacientes/medicacao", ...exigir("medicacao"), (req, res) => {
  const db = readDB();

  res.json(
    db.pacientes
      .filter(p => p.status === "aguardando_medicacao")
      .map(p => {
        const consulta = ultimo(db.consultas, c => Number(c.pacienteId) === Number(p.id));

        return {
          ...p,
          prescricao: consulta ? consulta.medicacao : "Não informada",
          prescricaoDetalhes: consulta && consulta.prescricao ? consulta.prescricao : null,
          diagnostico: consulta ? consulta.diagnostico : "N/A"
        };
      })
  );
});

app.post("/medicacao/aplicar", ...exigir("medicacao"), (req, res) => {
  const db = readDB();

  const paciente = exigirPaciente(
    db, req.body && req.body.pacienteId, null,
    "aguardando_medicacao",
    "Este paciente não está aguardando medicação."
  );

  const consulta = ultimo(db.consultas, c => Number(c.pacienteId) === Number(paciente.id));
  const prescrita = consulta ? texto(consulta.medicacao) : "";

  // Baixa no estoque quando a prescrição corresponde a uma medicação cadastrada
  const item = prescrita
    ? db.medicacoesDisponiveis.find(m => mesmoLogin(m.nome, prescrita))
    : null;
  if (prescrita && !item) {
    throw new ErroHttp(409, "A medicação prescrita não está mais cadastrada no estoque.");
  }
  const prescricao = consulta && consulta.prescricao;
  const quantidade = prescricao
    ? Number(prescricao.quantidade)
    : 1;

  if (item) {
    const atual = Number(item.quantidade) || 0;

    if (!Number.isSafeInteger(quantidade) || quantidade < 1 || atual < quantidade) {
      throw new ErroHttp(409, `Sem estoque de ${item.nome}. Reponha antes de aplicar.`);
    }

    item.quantidade = atual - quantidade;
    registrarMovimento(
      db, item, "saida", quantidade, atual,
      `Aplicação em ${paciente.nome}`, req.user.nome
    );
  }

  const aplicacao = {
    id: novoId(),
    pacienteId: paciente.id,
    paciente: paciente.nome,
    medicacao: prescrita,
    dose: prescricao ? prescricao.dose : "",
    via: prescricao ? prescricao.via : "",
    frequencia: prescricao ? prescricao.frequencia : "",
    quantidade: item ? quantidade : 0,
    aplicadoPor: req.user.nome,
    createdAt: agora()
  };
  db.medicacoes.push(aplicacao);

  paciente.status = "aguardando_alta";
  registrarAuditoria(db, req.user.nome, "registrar", "medicacao", aplicacao.id);
  writeDB(db);

  res.json({ sucesso: true, mensagem: "Medicação concluída. Encaminhado para alta." });
});

// =====================================================
// API - ALTA
// =====================================================

app.get("/pacientes/atendidos", ...exigir("alta"), (req, res) => {
  res.json(readDB().pacientes.filter(p => p.status === "aguardando_alta"));
});

app.post("/alta", ...exigir("alta"), (req, res) => {
  const db = readDB();
  const body = req.body || {};

  const paciente = exigirPaciente(
    db, body.pacienteId, null,
    "aguardando_alta",
    "Este paciente não está aguardando alta."
  );

  if (!TIPOS_ALTA.includes(body.tipoAlta)) {
    throw new ErroHttp(400, "Selecione um tipo de alta válido.");
  }

  paciente.status = "alta";
  paciente.dataAlta = agora();

  const registroAlta = {
    id: novoId(),
    pacienteId: paciente.id,
    paciente: paciente.nome,
    tipoAlta: body.tipoAlta,
    orientacoes: texto(body.orientacoes),
    funcionario: req.user.nome,
    createdAt: agora()
  };

  db.altas.push(registroAlta);
  registrarAuditoria(db, req.user.nome, "registrar", "alta", registroAlta.id);
  writeDB(db);

  res.json({ sucesso: true, registroAlta });
});

app.get("/altas", ...exigir("alta"), (req, res) => {
  res.json(readDB().altas);
});

// =====================================================
// API - PRONTUÁRIO (médico, triagem e administrador)
// =====================================================

app.get("/prontuario", ...exigir("medico", "triagem"), (req, res) => {
  const busca = texto(req.query.busca);
  if (busca.length < 2) return res.json([]);

  const db = readDB();
  const nomeBusca = busca.toLocaleLowerCase("pt-BR");
  const cpfBusca = cpfNormalizado(busca);
  const encontrados = new Map();

  db.pacientes.forEach(paciente => {
    const nomeConfere = texto(paciente.nome).toLocaleLowerCase("pt-BR").includes(nomeBusca);
    const cpfPaciente = cpfNormalizado(paciente.cpf);
    const cpfConfere = cpfBusca.length >= 3 && cpfPaciente.includes(cpfBusca);
    if (!nomeConfere && !cpfConfere) return;

    const chave = cpfPaciente || `id:${paciente.id}`;
    const registro = encontrados.get(chave) || {
      cpf: paciente.cpf || "",
      nome: paciente.nome || "",
      visitas: 0,
      ultimaVisita: paciente.createdAt || null,
      dataMaisRecente: 0
    };
    registro.visitas += 1;
    const dataVisita = Date.parse(paciente.createdAt);
    if (Number.isFinite(dataVisita) && dataVisita >= registro.dataMaisRecente) {
      registro.dataMaisRecente = dataVisita;
      registro.ultimaVisita = paciente.createdAt;
      registro.nome = paciente.nome || registro.nome;
    }
    encontrados.set(chave, registro);
  });

  db.pessoas.forEach(pessoa => {
    const nomeConfere = texto(pessoa.nome).toLocaleLowerCase("pt-BR").includes(nomeBusca);
    const cpfPessoa = cpfNormalizado(pessoa.cpf);
    const cpfConfere = cpfBusca.length >= 3 && cpfPessoa.includes(cpfBusca);
    if (!nomeConfere && !cpfConfere) return;

    const chave = cpfPessoa || `pessoa:${pessoa.id}`;
    if (!encontrados.has(chave)) {
      encontrados.set(chave, {
        cpf: pessoa.cpf || "",
        nome: pessoa.nome || "",
        visitas: 0,
        ultimaVisita: null,
        dataMaisRecente: 0
      });
    }
  });

  registrarAuditoria(db, req.user.nome, "consultar_busca", "prontuario");
  writeDB(db);
  res.json([...encontrados.values()]
    .sort((a, b) => b.dataMaisRecente - a.dataMaisRecente)
    .map(({ dataMaisRecente, ...pessoa }) => pessoa));
});

app.get("/prontuario/paciente", ...exigir("medico", "triagem"), (req, res) => {
  const cpf = cpfNormalizado(req.query.cpf);
  if (cpf.length !== 11) throw new ErroHttp(400, "Informe um CPF válido.");

  const db = readDB();
  const atendimentos = db.pacientes
    .filter(paciente => cpfNormalizado(paciente.cpf) === cpf)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));

  const perfil = db.pessoas.find(item => cpfNormalizado(item.cpf) === cpf);
  const internacoesDaPessoa = db.internacoes
    .filter(internacao => {
      const pessoa = db.pessoas.find(item => Number(item.id) === Number(internacao.pessoaId));
      return pessoa && cpfNormalizado(pessoa.cpf) === cpf;
    })
    .sort((a, b) => Date.parse(b.admitidoEm || 0) - Date.parse(a.admitidoEm || 0));
  const pessoaId = perfil && Number(perfil.id);
  const examesDaPessoa = pessoaId
    ? db.solicitacoesExames
      .filter(item => Number(item.pessoaId) === pessoaId)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .map(item => formatarSolicitacaoExame(db, item))
    : [];
  const cirurgiasDaPessoa = pessoaId
    ? db.cirurgias
      .filter(item => Number(item.pessoaId) === pessoaId)
      .sort((a, b) => Date.parse(b.inicio || 0) - Date.parse(a.inicio || 0))
      .map(item => formatarCirurgia(db, item))
    : [];
  if (!atendimentos.length && !perfil && !internacoesDaPessoa.length &&
      !examesDaPessoa.length && !cirurgiasDaPessoa.length) {
    throw new ErroHttp(404, "Paciente não encontrado.");
  }

  const atual = atendimentos[0] || {};
  const alergias = [...new Set(atendimentos.flatMap(paciente => listarAlergias(db, paciente)))];
  if (perfil && Array.isArray(perfil.alergias)) alergias.push(...perfil.alergias);
  const pessoa = {
    nome: perfil && perfil.nome || atual.nome,
    cpf: perfil && perfil.cpf || atual.cpf,
    sexo: perfil && perfil.sexo || atual.sexo,
    estado_civil: perfil && perfil.estado_civil || atual.estado_civil,
    tipo: perfil && perfil.tipo || atual.tipo,
    nome_mae: perfil && perfil.nome_mae || atual.nome_mae,
    telefone: perfil && perfil.telefone || atual.telefone,
    email: perfil && perfil.email || atual.email,
    endereco: perfil && perfil.endereco || atual.endereco,
    contato_emergencia: perfil && perfil.contato_emergencia || atual.contato_emergencia,
    historicoMedico: perfil && perfil.historicoMedico || atual.historicoMedico || "",
    doencasPreexistentes: perfil && perfil.doencasPreexistentes || atual.doencasPreexistentes || ""
  };
  const visitas = atendimentos.map(paciente => {
    const triagens = db.triagens.filter(t => Number(t.pacienteId) === Number(paciente.id));
    const consultas = db.consultas
      .filter(c => Number(c.pacienteId) === Number(paciente.id))
      .map(consulta => ({
        ...consulta,
        prescricaoTexto: consulta.prescricaoTexto ||
          [consulta.medicacao, consulta.dose, consulta.via, consulta.frequencia].filter(Boolean).join(" · ")
      }));
    return {
      entrada: paciente.createdAt,
      cadastradoPor: paciente.cadastradoPor,
      status: paciente.status,
      risco: paciente.risco,
      triagens,
      consultas,
      medicacoes: db.medicacoes.filter(m => Number(m.pacienteId) === Number(paciente.id)),
      alta: ultimo(db.altas, alta => Number(alta.pacienteId) === Number(paciente.id)) || null
    };
  });

  const internacoes = internacoesDaPessoa.map(internacao => ({
    ...formatarInternacao(db, internacao),
    evolucoes: db.evolucoesEnfermagem.filter(item => Number(item.internacaoId) === Number(internacao.id)),
    sinaisVitais: db.sinaisVitaisEnfermagem.filter(item => Number(item.internacaoId) === Number(internacao.id)),
    balancoHidrico: db.balancosHidricos.filter(item => Number(item.internacaoId) === Number(internacao.id)),
    procedimentos: db.procedimentosEnfermagem.filter(item => Number(item.internacaoId) === Number(internacao.id)),
    prescricoes: db.prescricoesInternacao
      .filter(item => Number(item.internacaoId) === Number(internacao.id))
      .map(prescricao => {
        const medicamento = db.medicacoesDisponiveis.find(
          item => Number(item.id) === Number(prescricao.medicacaoId)
        );
        return {
          ...prescricao,
          medicacao: medicamento ? { id: medicamento.id, nome: medicamento.nome } : null,
          administracoes: db.administracoesMedicacao.filter(
            item => Number(item.prescricaoId) === Number(prescricao.id)
          )
        };
      })
  }));

  registrarAuditoria(
    db,
    req.user.nome,
    "consultar_detalhe",
    "prontuario",
    atual.id || perfil && perfil.id || internacoesDaPessoa[0].id
  );
  writeDB(db);
  res.json({
    pessoa,
    alergias: [...new Set(alergias)],
    visitas,
    internacoes,
    exames: examesDaPessoa,
    cirurgias: cirurgiasDaPessoa
  });
});

// =====================================================
// API - RELATÓRIOS (somente administrador)
// =====================================================

function dataBrasilia(valor) {
  const dataValor = new Date(valor);
  if (!Number.isFinite(dataValor.getTime())) return "";
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(dataValor);
  const data = Object.fromEntries(partes.map(parte => [parte.type, parte.value]));
  return `${data.year}-${data.month}-${data.day}`;
}

function media(valores) {
  return valores.length
    ? Math.round(valores.reduce((total, valor) => total + valor, 0) / valores.length)
    : null;
}

app.get("/relatorios/resumo", ...exigir("gestor"), (req, res) => {
  const periodo = texto(req.query.periodo || "7");
  if (!["hoje", "7", "30"].includes(periodo)) {
    throw new ErroHttp(400, "Selecione um período válido.");
  }

  const dias = periodo === "hoje" ? 1 : Number(periodo);
  const agoraData = new Date();
  const hoje = dataBrasilia(agoraData);
  const partesHoje = hoje.split("-").map(Number);
  const inicioCalendario = new Date(Date.UTC(
    partesHoje[0], partesHoje[1] - 1, partesHoje[2] - (dias - 1)
  ));
  const dataInicio = inicioCalendario.toISOString().slice(0, 10);
  const inicio = new Date(`${dataInicio}T03:00:00.000Z`).getTime();
  const fim = agoraData.getTime();
  const noPeriodo = registro => {
    const data = Date.parse(registro && registro.createdAt);
    return Number.isFinite(data) && data >= inicio && data <= fim;
  };
  const chaveData = valor => dataBrasilia(valor);
  const db = readDB();
  const pacientes = db.pacientes.filter(noPeriodo);
  const triagens = db.triagens.filter(noPeriodo);
  const consultas = db.consultas.filter(noPeriodo);
  const altas = db.altas.filter(noPeriodo);
  const movimentacoes = db.movimentacoes.filter(noPeriodo);
  const medicacoes = db.medicacoes.filter(noPeriodo);

  const serie = [];
  if (periodo === "hoje") {
    const porHora = new Map();
    pacientes.forEach(paciente => {
      const hora = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        hourCycle: "h23"
      }).format(new Date(paciente.createdAt));
      porHora.set(hora, (porHora.get(hora) || 0) + 1);
    });
    for (let hora = 0; hora < 24; hora++) {
      const rotulo = String(hora).padStart(2, "0");
      serie.push({ rotulo, total: porHora.get(rotulo) || 0 });
    }
  } else {
    for (let indice = 0; indice < dias; indice++) {
      const data = new Date(inicioCalendario);
      data.setUTCDate(data.getUTCDate() + indice);
      const chave = data.toISOString().slice(0, 10);
      const total = pacientes.filter(paciente => chaveData(paciente.createdAt) === chave).length;
      serie.push({ rotulo: chave.slice(8) + "/" + chave.slice(5, 7), total });
    }
  }

  const risco = { vermelho: 0, amarelo: 0, verde: 0 };
  triagens.forEach(triagem => {
    if (Object.prototype.hasOwnProperty.call(risco, triagem.risco)) risco[triagem.risco] += 1;
  });

  const esperaTriagem = [];
  triagens.forEach(triagem => {
    const paciente = db.pacientes.find(p => Number(p.id) === Number(triagem.pacienteId));
    const inicioAtendimento = Date.parse(paciente && paciente.createdAt);
    const fimTriagem = Date.parse(triagem.createdAt);
    if (Number.isFinite(inicioAtendimento) && Number.isFinite(fimTriagem) && fimTriagem >= inicioAtendimento) {
      esperaTriagem.push((fimTriagem - inicioAtendimento) / 60000);
    }
  });

  const esperasPorRisco = { vermelho: [], amarelo: [], verde: [] };
  const esperaMedico = [];
  consultas.forEach(consulta => {
    const triagem = ultimo(db.triagens.filter(t => Number(t.pacienteId) === Number(consulta.pacienteId)),
      t => Date.parse(t.createdAt) <= Date.parse(consulta.createdAt));
    const inicioConsulta = Date.parse(triagem && triagem.createdAt);
    const fimConsulta = Date.parse(consulta.createdAt);
    if (Number.isFinite(inicioConsulta) && Number.isFinite(fimConsulta) && fimConsulta >= inicioConsulta) {
      const minutos = (fimConsulta - inicioConsulta) / 60000;
      esperaMedico.push(minutos);
      if (esperasPorRisco[triagem.risco]) esperasPorRisco[triagem.risco].push(minutos);
    }
  });

  const permanencia = altas.flatMap(alta => {
    const paciente = db.pacientes.find(p => Number(p.id) === Number(alta.pacienteId));
    const entrada = Date.parse(paciente && paciente.createdAt);
    const saida = Date.parse(alta.createdAt);
    return Number.isFinite(entrada) && Number.isFinite(saida) && saida >= entrada
      ? [(saida - entrada) / 60000]
      : [];
  });

  const usoPorMedicacao = new Map();
  movimentacoes.filter(movimento => movimento.tipo === "saida").forEach(movimento => {
    const nome = movimento.medicacao || "Não informado";
    usoPorMedicacao.set(nome, (usoPorMedicacao.get(nome) || 0) + Number(movimento.quantidade || 0));
  });
  const altasPorTipo = new Map();
  altas.forEach(alta => altasPorTipo.set(alta.tipoAlta, (altasPorTipo.get(alta.tipoAlta) || 0) + 1));

  const emAndamento = {};
  db.pacientes.filter(paciente => paciente.status !== "alta").forEach(paciente => {
    emAndamento[paciente.status] = (emAndamento[paciente.status] || 0) + 1;
  });

  const atividades = new Map();
  const contarAtividade = (nome, campo) => {
    if (!nome) return;
    const atividade = atividades.get(nome) || {
      nome, cadastros: 0, triagens: 0, consultas: 0, medicacoes: 0, altas: 0, estoque: 0, total: 0
    };
    atividade[campo] += 1;
    atividade.total += 1;
    atividades.set(nome, atividade);
  };
  pacientes.forEach(paciente => contarAtividade(paciente.cadastradoPor, "cadastros"));
  triagens.forEach(triagem => contarAtividade(triagem.funcionario, "triagens"));
  consultas.forEach(consulta => contarAtividade(consulta.medico, "consultas"));
  medicacoes.forEach(medicacao => contarAtividade(medicacao.aplicadoPor, "medicacoes"));
  altas.forEach(alta => contarAtividade(alta.funcionario, "altas"));
  movimentacoes.forEach(movimento => contarAtividade(movimento.funcionario, "estoque"));

  const internacoesAtivas = db.internacoes.filter(item => item.status === "ativa");
  const leitosOcupados = db.leitos.filter(leito => internacaoAtivaNoLeito(db, leito.id)).length;
  const leitosOperacionais = db.leitos.filter(leito => leito.status !== "manutencao").length;
  const consultasHoje = db.agendamentos.filter(item =>
    item.data === hoje && ["agendada", "confirmada"].includes(item.status)
  ).length;
  const cirurgiasHoje = db.cirurgias.filter(item =>
    dataBrasilia(item.inicio) === hoje && item.status === "agendada"
  ).length;

  registrarAuditoria(db, req.user.nome, "consultar", "relatorios");
  writeDB(db);
  res.json({
    periodo,
    indicadoresHoje: {
      atendimentos: db.pacientes.filter(paciente => dataBrasilia(paciente.createdAt) === hoje).length,
      consultas: consultasHoje,
      medicosAtivos: db.usuarios.filter(usuario => usuario.tipo === "medico").length,
      internacoesAtivas: internacoesAtivas.length,
      cirurgiasHoje,
      examesPendentes: db.solicitacoesExames.filter(item =>
        ["solicitado", "coletado"].includes(item.status)
      ).length,
      leitosDisponiveis: Math.max(0, leitosOperacionais - leitosOcupados),
      leitosOcupados,
      taxaOcupacao: leitosOperacionais
        ? Math.round((leitosOcupados / leitosOperacionais) * 100)
        : 0
    },
    totais: {
      atendimentos: pacientes.length,
      altas: altas.length,
      emAndamento: db.pacientes.filter(paciente => paciente.status !== "alta").length
    },
    tempos: {
      esperaTriagem: media(esperaTriagem),
      esperaMedico: media(esperaMedico),
      esperaMedicoPorRisco: {
        vermelho: media(esperasPorRisco.vermelho),
        amarelo: media(esperasPorRisco.amarelo),
        verde: media(esperasPorRisco.verde)
      },
      permanencia: media(permanencia)
    },
    serie,
    risco,
    medicacoesMaisUsadas: [...usoPorMedicacao.entries()]
      .map(([nome, quantidade]) => ({ nome, quantidade }))
      .sort((a, b) => b.quantidade - a.quantidade)
      .slice(0, 5),
    estoqueCritico: db.medicacoesDisponiveis
      .filter(item => Number(item.quantidade) <= 10)
      .map(item => ({ nome: item.nome, quantidade: Number(item.quantidade) || 0 })),
    altasPorTipo: [...altasPorTipo.entries()].map(([tipo, total]) => ({ tipo, total })),
    emAndamento,
    funcionarios: [...atividades.values()].sort((a, b) => b.total - a.total)
  });
});

app.get("/backup", ...exigir(), (req, res) => {
  const banco = readDB();
  registrarAuditoria(banco, req.user.nome, "baixar_backup", "sistema");
  writeDB(banco);
  const dados = clone(banco);
  dados.usuarios = dados.usuarios.map(({ senha, ...usuario }) => usuario);

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `attachment; filename="baymax-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ geradoEm: agora(), incluiCredenciais: false, dados });
});

// =====================================================
// API - CHAMADAS DA TV
// =====================================================

// A TV não tem login: só leitura das chamadas
app.get("/tv/chamada", (req, res) => {
  const { chamadas } = readDB();

  res.json({
    chamada: chamadas.length ? chamadas[chamadas.length - 1] : null,
    historico: [...chamadas].reverse().slice(1)
  });
});

app.post("/tv/chamar", ...exigir("atendimento", "triagem", "medico"), (req, res) => {
  const db = readDB();
  const body = req.body || {};

  const chamada = {
    id: novoId(),
    paciente: texto(body.paciente || body.nome).slice(0, 120) || "PACIENTE",
    localTipo: texto(body.localTipo).slice(0, 30) || "GUICHÊ",
    localNumero: texto(body.localNumero).slice(0, 10) || "---",
    chamadoPor: req.user.nome,
    createdAt: agora()
  };

  db.chamadas.push(chamada);
  db.chamadas = db.chamadas.slice(-50);

  writeDB(db);
  res.json({ sucesso: true, chamada });
});

app.delete("/tv/chamada", ...exigir(), (req, res) => {
  const db = readDB();
  db.chamadas = [];
  writeDB(db);

  res.json({ sucesso: true, mensagem: "Chamadas da TV removidas" });
});

// =====================================================
// TRATAMENTO DE ERROS
// =====================================================

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof ErroHttp) {
    return res.status(err.status).json({ erro: err.message });
  }

  // JSON inválido enviado pelo cliente
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ erro: "JSON inválido." });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({ erro: "Os dados enviados são grandes demais." });
  }

  console.error("Erro no servidor:", err);
  return res.status(500).json({ erro: "Erro interno do servidor." });
});

// =====================================================
// INICIAR SERVIDOR
// =====================================================

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log(`Frontend: ${frontendPath}`);
    console.log(`Banco de dados: ${DB_FILE}`);
  });
}

module.exports = app;