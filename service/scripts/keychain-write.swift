import Darwin
import Foundation
import Security

guard CommandLine.arguments.count == 3 else {
  exit(EX_USAGE)
}

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
var password = FileHandle.standardInput.readDataToEndOfFile()
guard !password.isEmpty else {
  exit(EX_DATAERR)
}

let query: [CFString: Any] = [
  kSecClass: kSecClassGenericPassword,
  kSecAttrService: service,
  kSecAttrAccount: account,
]
let attributes: [CFString: Any] = [kSecValueData: password]

var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
if status == errSecItemNotFound {
  var item = query
  item[kSecValueData] = password
  status = SecItemAdd(item as CFDictionary, nil)
  if status == errSecDuplicateItem {
    status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
  }
}

guard status == errSecSuccess else {
  exit(EX_SOFTWARE)
}
